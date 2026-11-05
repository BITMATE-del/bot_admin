import express from 'express';
import pg from 'pg';
import helmet from 'helmet';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mtprotoConfigured, resolveTelegramUsername, fetchGroupParticipants } from './mtproto.js';
import { mountImageBot } from './image-bot.js';

const required = ['BOT_TOKEN','DATABASE_URL','PUBLIC_URL','WEBHOOK_SECRET','SESSION_SECRET','ADMIN_SECOND_PASSWORD','OPERATOR_TELEGRAM_IDS'];
for (const key of required) if (!process.env[key]) throw new Error('Missing environment variable: '+key);
if (process.env.SESSION_SECRET.length < 32 || process.env.WEBHOOK_SECRET.length < 16) throw new Error('Secrets are too short');
const operators = new Set(process.env.OPERATOR_TELEGRAM_IDS.split(',').map(x=>x.trim()).filter(Boolean));
if (!operators.size) throw new Error('At least one operator required');
const token=process.env.BOT_TOKEN, base=process.env.PUBLIC_URL.replace(/\/$/,'');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==='false'?false:{rejectUnauthorized:true}});
const app=express();
app.disable('x-powered-by');app.set('trust proxy',1);app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:'100kb'}));
const limits=new Map();
const now=()=>Date.now();
const sign=s=>crypto.createHmac('sha256',process.env.SESSION_SECRET).update(s).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const safeId=x=>{const s=String(x??'');return /^-?\d{1,20}$/.test(s)?s:null};
const positiveId=x=>{const s=String(x??'');return /^\d{1,20}$/.test(s)?s:null};
const requestIp=req=>req.ip||'unknown';
const limited=(key,max=8,windowMs=600000)=>{const old=limits.get(key)||[];const arr=old.filter(t=>now()-t<windowMs);arr.push(now());limits.set(key,arr);return arr.length>max};
async function tg(method,data={}){const resp=await fetch('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(12000)});const json=await resp.json();if(!json.ok)throw new Error(json.description||'Telegram '+method+' failed');return json.result}
async function sql(query,params=[]){return (await pool.query(query,params)).rows}
async function init(){
 await pool.query(`CREATE TABLE IF NOT EXISTS groups(chat_id BIGINT PRIMARY KEY,title TEXT NOT NULL,member_count INTEGER,bot_promote BOOLEAN DEFAULT FALSE,bot_change BOOLEAN DEFAULT FALSE,updated_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS members(chat_id BIGINT NOT NULL,user_id BIGINT NOT NULL,first_name TEXT DEFAULT '',last_name TEXT DEFAULT '',username TEXT DEFAULT '',last_seen TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(chat_id,user_id));
 CREATE INDEX IF NOT EXISTS members_search_idx ON members(chat_id, lower(first_name),lower(username));
 CREATE TABLE IF NOT EXISTS audit(id BIGSERIAL PRIMARY KEY,operator_id BIGINT NOT NULL,chat_id BIGINT NOT NULL,action TEXT NOT NULL,target_id BIGINT,details JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS update_dedup(update_id BIGINT PRIMARY KEY,created_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS admin_sessions(token_hash TEXT PRIMARY KEY,expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW());
 ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS access_id BIGINT;
 CREATE TABLE IF NOT EXISTS access_keys(id BIGSERIAL PRIMARY KEY,label TEXT NOT NULL,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS access_key_groups(access_id BIGINT NOT NULL REFERENCES access_keys(id) ON DELETE CASCADE,chat_id BIGINT NOT NULL REFERENCES groups(chat_id) ON DELETE CASCADE,PRIMARY KEY(access_id,chat_id));
 CREATE INDEX IF NOT EXISTS access_key_groups_chat_idx ON access_key_groups(chat_id);
 ALTER TABLE groups ADD COLUMN IF NOT EXISTS username TEXT;
 ALTER TABLE groups ADD COLUMN IF NOT EXISTS is_connected BOOLEAN NOT NULL DEFAULT TRUE;
 CREATE TABLE IF NOT EXISTS recent_messages(chat_id BIGINT NOT NULL,message_id BIGINT NOT NULL,user_id BIGINT NOT NULL,first_name TEXT NOT NULL DEFAULT '',last_name TEXT NOT NULL DEFAULT '',username TEXT NOT NULL DEFAULT '',preview TEXT NOT NULL DEFAULT '',sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(chat_id,message_id));
 CREATE INDEX IF NOT EXISTS recent_messages_by_group ON recent_messages(chat_id,sent_at DESC,message_id DESC);`);
}
async function remember(chat,user){if(!chat||!user||user.is_bot)return;await sql(`INSERT INTO members(chat_id,user_id,first_name,last_name,username) VALUES($1,$2,$3,$4,$5) ON CONFLICT(chat_id,user_id) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,username=EXCLUDED.username,last_seen=NOW()`,[chat.id,user.id,user.first_name||'',user.last_name||'',user.username||''])}
async function captureMessage(msg){
 if(!msg?.from?.id||msg.from.is_bot||!msg.message_id||!msg.chat?.id)return;
 const content=String(msg.text||msg.caption||((msg.photo||msg.video||msg.document||msg.voice||msg.sticker)?'[미디어 메시지]':'[기타 메시지]')).slice(0,240);
 await sql(`INSERT INTO recent_messages(chat_id,message_id,user_id,first_name,last_name,username,preview,sent_at) VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8))
 ON CONFLICT(chat_id,message_id) DO UPDATE SET preview=EXCLUDED.preview,first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,username=EXCLUDED.username`,[
 msg.chat.id,msg.message_id,msg.from.id,msg.from.first_name||'',msg.from.last_name||'',msg.from.username||'',content,msg.date||Math.floor(Date.now()/1000)]);
 await sql(`DELETE FROM recent_messages WHERE chat_id=$1 AND (sent_at<NOW()-interval '7 days' OR message_id IN (
 SELECT message_id FROM recent_messages WHERE chat_id=$1 ORDER BY sent_at DESC,message_id DESC OFFSET 50))`,[msg.chat.id]);
}
async function syncGroup(chat){if(!chat||!['supergroup','group'].includes(chat.type))return;await sql(`INSERT INTO groups(chat_id,title,username) VALUES($1,$2,$3) ON CONFLICT(chat_id) DO UPDATE SET title=EXCLUDED.title,username=COALESCE(EXCLUDED.username,groups.username),updated_at=NOW()`,[chat.id,chat.title||'그룹',chat.username||null]);}
const connectedStatus=status=>status==='administrator'||status==='member'||status==='creator'||status==='restricted';
async function setGroupConnection(id,active){
 await sql('UPDATE groups SET is_connected=$2,bot_promote=CASE WHEN $2 THEN bot_promote ELSE FALSE END,bot_change=CASE WHEN $2 THEN bot_change ELSE FALSE END,updated_at=NOW() WHERE chat_id=$1',[id,active]);
}
async function checkBotMembership(id,botId){
 try{
  const state=await tg('getChatMember',{chat_id:id,user_id:botId});
  const connected=connectedStatus(state.status);
  await setGroupConnection(id,connected);
  return {connected,state};
 }catch(e){
  // If Telegram clearly says the bot can no longer access this group, hide it.
  // On temporary network or rate-limit errors leave previous status untouched.
  if(/bot was kicked|bot is not a member|chat not found|forbidden: bot|user not found/i.test(e.message)){
   await setGroupConnection(id,false);return {connected:false,state:null};
  }
  throw e;
 }
}
async function refreshGroup(id){
 const me=await tg('getMe');
 const checked=await checkBotMembership(id,me.id);
 if(!checked.connected)throw new Error('봇이 이 그룹에서 추방되었거나 더 이상 참여 중이 아닙니다');
 const c=await tg('getChat',{chat_id:id});await syncGroup(c);
 const count=await tg('getChatMemberCount',{chat_id:id});
 const status=checked.state;
 await sql('UPDATE groups SET member_count=$2,bot_promote=$3,bot_change=$4,is_connected=TRUE,updated_at=NOW() WHERE chat_id=$1',[id,count,Boolean(status.can_promote_members),Boolean(status.can_change_info)]);
 return status;
}
async function reconcileGroups(){
 const me=await tg('getMe');
 const rows=await sql('SELECT chat_id::text FROM groups');
 for(const g of rows){
  try{await checkBotMembership(g.chat_id,me.id)}
  catch(e){console.warn('group membership check failed:',g.chat_id,e.message)}
 }
}
async function onUpdate(u){
 const msg=u.message||u.edited_message;
 if(msg?.chat?.type==='private'&&operators.has(String(msg.from?.id))&&msg.text?.startsWith('/start')){await tg('sendMessage',{chat_id:msg.chat.id,text:'🛡 비상 그룹 관리자 봇 연결 완료. 웹 관리 페이지에서 본인의 Telegram ID로 인증하세요.\n내 ID: '+msg.from.id});return}
 if(msg&&['supergroup','group'].includes(msg.chat?.type)){await syncGroup(msg.chat);await remember(msg.chat,msg.from);await captureMessage(msg);for(const m of msg.new_chat_members||[])await remember(msg.chat,m);if(msg.reply_to_message?.from)await remember(msg.chat,msg.reply_to_message.from);if(msg.new_chat_title)await syncGroup({...msg.chat,title:msg.new_chat_title});}
 if(u.chat_member){await syncGroup(u.chat_member.chat);await remember(u.chat_member.chat,u.chat_member.new_chat_member?.user)}
 if(u.my_chat_member){
  const event=u.my_chat_member;
  await syncGroup(event.chat);
  const nextStatus=event.new_chat_member?.status;
  if(!connectedStatus(nextStatus)){
   await setGroupConnection(event.chat.id,false);
   console.log('Bot disconnected from group:',event.chat.id,nextStatus);
  }else{
   await setGroupConnection(event.chat.id,true);
   try{await refreshGroup(event.chat.id)}catch(e){console.error('bot membership refresh:',e.message)}
  }
 }
}
app.post('/telegram/webhook',async(req,res)=>{if(!equal(req.get('x-telegram-bot-api-secret-token')||'',process.env.WEBHOOK_SECRET))return res.sendStatus(403);const u=req.body;if(!Number.isSafeInteger(u?.update_id))return res.sendStatus(400);try{const rows=await sql('INSERT INTO update_dedup(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id',[u.update_id]);if(rows.length){try{await onUpdate(u)}catch(err){await sql('DELETE FROM update_dedup WHERE update_id=$1',[u.update_id]);throw err}}return res.sendStatus(200)}catch(e){console.error('webhook:',e);return res.sendStatus(500)}});
function cookie(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>{const i=x.indexOf('=');return i<0?['','']:[x.slice(0,i).trim(),x.slice(i+1)]}))}
const hashPassword=(password,salt)=>crypto.scryptSync(password,Buffer.from(salt,'hex'),64).toString('hex');
const newAccessPassword=()=>crypto.randomBytes(18).toString('base64url');
async function auth(req,res,next){try{
 const sid=cookie(req).sid||'';
 if(!/^[a-f0-9]{64}$/.test(sid))return res.status(401).json({error:'로그인이 필요합니다'});
 const rows=await sql(`SELECT s.access_id::text AS access_id,k.active FROM admin_sessions s LEFT JOIN access_keys k ON k.id=s.access_id
 WHERE s.token_hash=$1 AND s.expires_at>NOW()`,[sign(sid)]);
 if(!rows.length)return res.status(401).json({error:'세션이 만료되었습니다'});
 const accessId=rows[0].access_id;
 if(accessId!==null && rows[0].active!==true)return res.status(401).json({error:'관리 권한이 중지됐습니다. 본사에 문의하세요.'});
 req.accessId=accessId;
 req.isOwner=accessId===null;
 req.operator=accessId===null?'0':('-'+accessId);
 next();
}catch(e){next(e)}}
function ownerOnly(req,res,next){if(!req.isOwner)return res.status(403).json({error:'본사 관리자만 사용할 수 있습니다'});next()}
async function scopedGroup(req,res,next){try{
 const id=safeId(req.params.id);
 if(!id)return res.status(400).json({error:'잘못된 그룹 ID'});
 if(req.isOwner)return next();
 const allowed=await sql('SELECT 1 FROM access_key_groups WHERE access_id=$1 AND chat_id=$2',[req.accessId,id]);
 if(!allowed.length)return res.status(403).json({error:'이 그룹에 대한 관리 권한이 없습니다'});
 next();
}catch(e){next(e)}}
app.post('/api/auth/login',async(req,res,next)=>{try{
 if(limited('login:'+requestIp(req),8))return res.status(429).json({error:'로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.'});
 const password=String(req.body.password||'');
 let accessId=null;
 if(!equal(password,process.env.ADMIN_SECOND_PASSWORD)){
  const keys=await sql('SELECT id::text,password_salt,password_hash FROM access_keys WHERE active=TRUE');
  let match=null;
  for(const k of keys){const test=hashPassword(password,k.password_salt);if(equal(test,k.password_hash))match=k.id}
  if(!match)return res.status(403).json({error:'관리자 비밀번호가 올바르지 않습니다'});
  accessId=match;
 }
 const sid=crypto.randomBytes(32).toString('hex');
 await sql("INSERT INTO admin_sessions(token_hash,expires_at,access_id) VALUES($1,NOW()+INTERVAL '30 days',$2)",[sign(sid),accessId]);
 res.setHeader('Set-Cookie',`sid=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`);
 res.json({ok:true,role:accessId===null?'owner':'manager'});
}catch(e){next(e)}});
app.post('/api/auth/logout',auth,async(req,res,next)=>{try{
 const sid=cookie(req).sid||'';
 await sql('DELETE FROM admin_sessions WHERE token_hash=$1',[sign(sid)]);
 res.setHeader('Set-Cookie','sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
 res.json({ok:true});
}catch(e){next(e)}});
app.get('/api/me',auth,(req,res)=>res.json({role:req.isOwner?'owner':'manager',access_id:req.accessId}));
app.get('/api/groups',auth,async(req,res,next)=>{try{
 const q=req.isOwner?'SELECT chat_id::text,title,username,member_count,bot_promote,bot_change,updated_at FROM groups WHERE is_connected=TRUE ORDER BY updated_at DESC':
 'SELECT g.chat_id::text,g.title,g.username,g.member_count,g.bot_promote,g.bot_change,g.updated_at FROM groups g JOIN access_key_groups ag ON ag.chat_id=g.chat_id WHERE ag.access_id=$1 AND g.is_connected=TRUE ORDER BY g.updated_at DESC';
 res.json(await sql(q,req.isOwner?[]:[req.accessId]));
}catch(e){next(e)}});
function validateGroupIds(value){if(!Array.isArray(value)||value.length<1||value.length>100)throw new Error('관리할 그룹을 1개 이상 선택하세요');const ids=[...new Set(value.map(safeId))];if(ids.some(x=>!x))throw new Error('올바른 그룹 ID가 아닙니다');return ids}
async function writeAssignments(db,id,ids){
 const known=await db.query('SELECT chat_id::text FROM groups WHERE is_connected=TRUE AND chat_id=ANY($1::bigint[])',[ids]);
 if(known.rows.length!==ids.length)throw new Error('존재하지 않는 그룹이 포함되어 있습니다');
 await db.query('DELETE FROM access_key_groups WHERE access_id=$1',[id]);
 for(const g of ids)await db.query('INSERT INTO access_key_groups(access_id,chat_id) VALUES($1,$2)',[id,g]);
}
app.get('/api/access-keys',auth,ownerOnly,async(req,res,next)=>{try{
 const rows=await sql(`SELECT a.id::text,a.label,a.active,a.created_at,a.updated_at,
 COALESCE(array_agg(ag.chat_id::text) FILTER(WHERE ag.chat_id IS NOT NULL),'{}') AS groups
 FROM access_keys a LEFT JOIN access_key_groups ag ON a.id=ag.access_id
 GROUP BY a.id ORDER BY a.id DESC`);
 res.setHeader('Cache-Control','no-store');res.json(rows);
}catch(e){next(e)}});
app.post('/api/access-keys',auth,ownerOnly,async(req,res,next)=>{const db=await pool.connect();try{
 const label=String(req.body.label||'').trim().slice(0,80);if(!label)throw new Error('담당자 또는 관리 비밀번호 이름을 입력하세요');
 const ids=validateGroupIds(req.body.groups);
 const password=newAccessPassword(),salt=crypto.randomBytes(16).toString('hex'),hash=hashPassword(password,salt);
 await db.query('BEGIN');
 const result=await db.query('INSERT INTO access_keys(label,password_salt,password_hash) VALUES($1,$2,$3) RETURNING id::text',[label,salt,hash]);
 await writeAssignments(db,result.rows[0].id,ids);
 await db.query('COMMIT');
 res.json({ok:true,id:result.rows[0].id,password});
}catch(e){await db.query('ROLLBACK');next(e)}finally{db.release()}});
app.put('/api/access-keys/:id',auth,ownerOnly,async(req,res,next)=>{const db=await pool.connect();try{
 const id=positiveId(req.params.id);if(!id)return res.sendStatus(400);
 const label=String(req.body.label||'').trim().slice(0,80),ids=validateGroupIds(req.body.groups);
 if(!label)throw new Error('담당자명을 입력하세요');
 await db.query('BEGIN');
 const row=await db.query('UPDATE access_keys SET label=$2,updated_at=NOW() WHERE id=$1 RETURNING id',[id,label]);
 if(!row.rowCount)throw new Error('관리 비밀번호를 찾을 수 없습니다');
 await writeAssignments(db,id,ids);
 await db.query('COMMIT');res.json({ok:true});
}catch(e){await db.query('ROLLBACK');next(e)}finally{db.release()}});
app.post('/api/access-keys/:id/rotate',auth,ownerOnly,async(req,res,next)=>{const db=await pool.connect();try{
 const id=positiveId(req.params.id);if(!id)return res.sendStatus(400);
 const password=newAccessPassword(),salt=crypto.randomBytes(16).toString('hex'),hash=hashPassword(password,salt);
 await db.query('BEGIN');
 const r=await db.query('UPDATE access_keys SET password_salt=$2,password_hash=$3,updated_at=NOW() WHERE id=$1 RETURNING id',[id,salt,hash]);
 if(!r.rowCount)throw new Error('관리 비밀번호를 찾을 수 없습니다');
 await db.query('DELETE FROM admin_sessions WHERE access_id=$1',[id]);
 await db.query('COMMIT');res.json({ok:true,password});
}catch(e){await db.query('ROLLBACK');next(e)}finally{db.release()}});
app.post('/api/access-keys/:id/toggle',auth,ownerOnly,async(req,res,next)=>{const db=await pool.connect();try{
 const id=positiveId(req.params.id);if(!id||typeof req.body.active!=='boolean')return res.sendStatus(400);
 await db.query('BEGIN');
 const r=await db.query('UPDATE access_keys SET active=$2,updated_at=NOW() WHERE id=$1 RETURNING id',[id,req.body.active]);
 if(!r.rowCount)throw new Error('관리 비밀번호를 찾을 수 없습니다');
 await db.query('DELETE FROM admin_sessions WHERE access_id=$1',[id]);
 await db.query('COMMIT');res.json({ok:true});
}catch(e){await db.query('ROLLBACK');next(e)}finally{db.release()}});
app.use('/api/groups/:id',auth,scopedGroup);
app.post('/api/group-connections/reconcile',auth,ownerOnly,async(req,res,next)=>{try{
 if(limited('reconcile:'+requestIp(req),3,60000))return res.status(429).json({error:'잠시 후 다시 조회해 주세요'});
 await reconcileGroups();
 const active=await sql('SELECT COUNT(*)::int AS count FROM groups WHERE is_connected=TRUE');
 res.json({ok:true,connected_groups:active[0].count});
}catch(e){next(e)}});
app.post('/api/groups/:id/refresh',auth,async(req,res,next)=>{try{const id=safeId(req.params.id);if(!id)return res.sendStatus(400);await assertGroup(id);const status=await refreshGroup(id);res.json({ok:true,status:status.status,can_promote_members:!!status.can_promote_members,can_change_info:!!status.can_change_info,rights:Object.fromEntries(rightKeys.map(k=>[k,!!status[k]]))})}catch(e){next(e)}});
async function assertGroup(id){const r=await sql('SELECT chat_id FROM groups WHERE chat_id=$1 AND is_connected=TRUE',[id]);if(!r.length)throw new Error('연결되지 않았거나 봇이 추방된 그룹입니다')}
app.get('/api/groups/:id/recent-messages',auth,async(req,res,next)=>{try{
 const id=safeId(req.params.id);if(!id)return res.sendStatus(400);await assertGroup(id);
 const data=await sql(`SELECT message_id::text,user_id::text,first_name,last_name,username,preview,sent_at FROM recent_messages WHERE chat_id=$1 ORDER BY sent_at DESC,message_id DESC LIMIT 50`,[id]);
 res.setHeader('Cache-Control','no-store');res.json(data);
}catch(e){next(e)}});
app.get('/api/groups/:id/members',auth,async(req,res,next)=>{try{const id=safeId(req.params.id);if(!id)return res.sendStatus(400);await assertGroup(id);const q=String(req.query.q||'').trim().slice(0,80);const rows=await sql(`SELECT user_id::text,first_name,last_name,username,last_seen FROM members WHERE chat_id=$1 AND ($2='' OR lower(first_name||' '||last_name) LIKE '%'||lower($2)||'%' OR lower(username) LIKE '%'||lower($2)||'%' OR user_id::text LIKE '%'||$2||'%') ORDER BY last_seen DESC LIMIT 100`,[id,q]);res.json(rows)}catch(e){next(e)}});
// MTProto lookup is opt-in; all results are verified against the selected group through Bot API.
app.get('/api/mtproto/status',auth,(req,res)=>res.json({configured:mtprotoConfigured}));
app.post('/api/groups/:id/resolve-username',auth,async(req,res,next)=>{try{
 const chatId=safeId(req.params.id);if(!chatId)return res.sendStatus(400);await assertGroup(chatId);
 if(limited('resolve:'+req.operator+':'+requestIp(req),15,60000))return res.status(429).json({error:'조회 요청이 너무 많습니다'});
 const u=await resolveTelegramUsername(req.body.username);
 const member=await tg('getChatMember',{chat_id:chatId,user_id:u.user_id});
 if(!['member','administrator','restricted','creator'].includes(member.status))return res.status(404).json({error:'이 사용자는 선택한 그룹의 회원이 아닙니다'});
 const person=member.user||{};
 await remember({id:chatId},{id:u.user_id,first_name:person.first_name||u.first_name,last_name:person.last_name||u.last_name,username:person.username||u.username});
 res.json({user_id:u.user_id,first_name:person.first_name||u.first_name,last_name:person.last_name||u.last_name,username:person.username||u.username,status:member.status});
}catch(e){next(e)}});
app.post('/api/groups/:id/sync-members',auth,async(req,res,next)=>{try{
 const chatId=safeId(req.params.id);if(!chatId)return res.sendStatus(400);await assertGroup(chatId);
 if(limited('sync:'+req.operator+':'+chatId,3,300000))return res.status(429).json({error:'그룹 동기화는 5분당 3회까지 가능합니다'});
 const rows=await sql('SELECT username FROM groups WHERE chat_id=$1',[chatId]);
 const result=await fetchGroupParticipants({chatId,groupUsername:rows[0]?.username,limit:500});
 for(const user of result.users)await remember({id:chatId},{id:user.user_id,first_name:user.first_name,last_name:user.last_name,username:user.username});
 res.json({ok:true,imported:result.users.length,partial:result.partial,limit:result.limit});
}catch(e){next(e)}});
app.get('/api/groups/:id/admins',auth,async(req,res,next)=>{try{const id=safeId(req.params.id);if(!id)return res.sendStatus(400);await assertGroup(id);const admins=await tg('getChatAdministrators',{chat_id:id});res.json(admins.map(x=>({user_id:String(x.user.id),first_name:x.user.first_name||'',username:x.user.username||'',status:x.status,can_promote_members:!!x.can_promote_members,can_delete_messages:!!x.can_delete_messages})));}catch(e){next(e)}});
const rightKeys=['can_manage_chat','can_change_info','can_delete_messages','can_manage_video_chats','can_restrict_members','can_promote_members','can_invite_users','can_pin_messages','can_manage_topics'];
async function execute(req,res,next,action,params,method,body){try{const id=safeId(req.params.id);if(!id)return res.sendStatus(400);await assertGroup(id);const result=await tg(method,{chat_id:id,...body});await sql('INSERT INTO audit(operator_id,chat_id,action,target_id,details) VALUES($1,$2,$3,$4,$5)',[req.operator,id,action,params.target||null,JSON.stringify(params)]);res.json({ok:true,result})}catch(e){next(e)}}
app.get('/api/groups/:id/member-status/:userId',auth,async(req,res,next)=>{try{
 const id=safeId(req.params.id),user=positiveId(req.params.userId);
 if(!id||!user)return res.sendStatus(400);
 await assertGroup(id);
 const m=await tg('getChatMember',{chat_id:id,user_id:user});
 res.json({user_id:user,status:m.status,is_admin:m.status==='administrator'||m.status==='creator',rights:{can_delete_messages:!!m.can_delete_messages,can_restrict_members:!!m.can_restrict_members,can_invite_users:!!m.can_invite_users,can_promote_members:!!m.can_promote_members,can_change_info:!!m.can_change_info}});
}catch(e){next(e)}});
app.post('/api/groups/:id/promote',auth,async(req,res,next)=>{
 const target=positiveId(req.body.user_id);
 if(!target)return res.status(400).json({error:'유효한 사용자 ID가 아닙니다'});
 const rights={};for(const k of rightKeys)rights[k]=req.body.rights?.[k]===true;
 rights.can_manage_chat=true;rights.is_anonymous=false;rights.can_post_stories=false;rights.can_edit_stories=false;rights.can_delete_stories=false;
 try{
  const id=safeId(req.params.id);if(!id)return res.sendStatus(400);
  await assertGroup(id);
  const me=await tg('getMe');
  const bot=await tg('getChatMember',{chat_id:id,user_id:me.id});
  if(bot.status!=='administrator'||!bot.can_promote_members)return res.status(403).json({error:'봇에게 새 관리자 임명 권한이 없습니다. 텔레그램 그룹 관리자 설정에서 봇의 관리자 추가 권한을 켜주세요.'});
  const granted=rightKeys.filter(k=>rights[k]===true && bot[k]!==true && k!=='can_manage_chat');
  if(granted.length){
    const labels={can_change_info:'그룹 정보 변경',can_delete_messages:'메시지 삭제',can_manage_video_chats:'영상 채팅 관리',can_restrict_members:'회원 차단·제한',can_promote_members:'다른 관리자 임명',can_invite_users:'초대 링크 관리',can_pin_messages:'메시지 고정',can_manage_topics:'주제 관리'};
    return res.status(400).json({error:'봇에게 없는 권한을 임명할 수 없습니다: '+granted.map(k=>labels[k]||k).join(', ')+'. 체크를 해제하거나 텔레그램에서 봇 권한을 추가해주세요.',unavailable_rights:granted});
  }
  const before=await tg('getChatMember',{chat_id:id,user_id:target});
  if(before.status==='creator')return res.status(400).json({error:'소유자 권한은 변경할 수 없습니다'});
  if(!['member','administrator','restricted'].includes(before.status)||(before.status==='administrator'&&before.can_be_edited===false))return res.status(400).json({error:'대상 회원의 그룹 소속 또는 수정 권한을 확인할 수 없습니다'});
  await tg('promoteChatMember',{chat_id:id,user_id:target,...rights});
  const after=await tg('getChatMember',{chat_id:id,user_id:target});
  const verified=after.status==='administrator';
  await sql('INSERT INTO audit(operator_id,chat_id,action,target_id,details) VALUES($1,$2,$3,$4,$5)',[req.operator,id,'promote',target,JSON.stringify({rights,verified,result_status:after.status})]);
  if(!verified)return res.status(409).json({error:'권한 변경 요청은 수락됐지만 Telegram에서 관리자 상태가 확인되지 않았습니다.',status:after.status});
  return res.json({ok:true,verified:true,status:after.status,user_id:target,rights:{can_delete_messages:!!after.can_delete_messages,can_restrict_members:!!after.can_restrict_members,can_change_info:!!after.can_change_info,can_invite_users:!!after.can_invite_users}});
 }catch(e){next(e)}
});
app.post('/api/groups/:id/title',auth,(req,res,next)=>{const title=String(req.body.title||'').trim();if(!title||title.length>128)return res.sendStatus(400);execute(req,res,next,'set_title',{title},'setChatTitle',{title})});
app.post('/api/groups/:id/description',auth,(req,res,next)=>{const description=String(req.body.description||'');if(description.length>255)return res.sendStatus(400);execute(req,res,next,'set_description',{description},'setChatDescription',{description})});
app.post('/api/groups/:id/ban',auth,(req,res,next)=>{const target=positiveId(req.body.user_id);if(!target)return res.sendStatus(400);execute(req,res,next,'ban',{target},'banChatMember',{user_id:target})});
app.post('/api/groups/:id/unban',auth,(req,res,next)=>{const target=positiveId(req.body.user_id);if(!target)return res.sendStatus(400);execute(req,res,next,'unban',{target},'unbanChatMember',{user_id:target,only_if_banned:true})});
app.post('/api/groups/:id/invite',auth,(req,res,next)=>execute(req,res,next,'create_invite',{},'createChatInviteLink',{name:'Emergency admin generated',creates_join_request:false}));
app.get('/api/groups/:id/audit',auth,async(req,res,next)=>{try{const id=safeId(req.params.id);if(!id)return res.sendStatus(400);await assertGroup(id);res.json(await sql('SELECT id,operator_id::text,action,target_id::text,details,created_at FROM audit WHERE chat_id=$1 ORDER BY id DESC LIMIT 100',[id]))}catch(e){next(e)}});

app.post('/api/groups/:id/pin',auth,(req,res,next)=>{const mid=Number(req.body.message_id);if(!Number.isSafeInteger(mid)||mid<=0)return res.sendStatus(400);execute(req,res,next,'pin_message',{message_id:mid},'pinChatMessage',{message_id:mid,disable_notification:true})});
app.post('/api/groups/:id/delete-message',auth,(req,res,next)=>{const mid=Number(req.body.message_id);if(!Number.isSafeInteger(mid)||mid<=0)return res.sendStatus(400);execute(req,res,next,'delete_message',{message_id:mid},'deleteMessage',{message_id:mid})});
app.post('/api/groups/:id/lock',auth,(req,res,next)=>{if(typeof req.body.lock!=='boolean')return res.sendStatus(400);const lock=req.body.lock;execute(req,res,next,lock?'lock_chat':'unlock_chat',{lock},'setChatPermissions',{permissions:{can_send_messages:!lock,can_send_audios:!lock,can_send_documents:!lock,can_send_photos:!lock,can_send_videos:!lock,can_send_video_notes:!lock,can_send_voice_notes:!lock,can_send_polls:!lock,can_send_other_messages:!lock,can_add_web_page_previews:!lock,can_change_info:false,can_invite_users:!lock,can_pin_messages:false,can_manage_topics:false}})});
const startImageBot=mountImageBot(app,base);
app.get('/health',(_req,res)=>res.json({status:'ok'}));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)),'../public')));
app.use((e,req,res,next)=>{console.error(e);res.status(400).json({error:e.message||'요청 실패'})});
await init();const me=await tg('getMe');await tg('setWebhook',{url:base+'/telegram/webhook',secret_token:process.env.WEBHOOK_SECRET,allowed_updates:['message','edited_message','chat_member','my_chat_member'],drop_pending_updates:false});app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Admin bot started @'+me.username));
startImageBot().catch(e=>console.error('image bot webhook setup:',e.message));
reconcileGroups().catch(e=>console.error('startup membership reconciliation:',e.message));
setInterval(()=>reconcileGroups().catch(e=>console.error('scheduled membership reconciliation:',e.message)),300000).unref();
setInterval(()=>{for(const [id,v] of limits)if(v.every(t=>now()-t>600000))limits.delete(id);pool.query("DELETE FROM update_dedup WHERE created_at < NOW() - interval '7 days'").catch(console.error);pool.query('DELETE FROM admin_sessions WHERE expires_at<NOW()').catch(console.error)},3600000).unref();
