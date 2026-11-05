import express from 'express';
import pg from 'pg';
import helmet from 'helmet';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mtprotoConfigured, resolveTelegramUsername, fetchGroupParticipants } from './mtproto.js';

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
 ALTER TABLE groups ADD COLUMN IF NOT EXISTS username TEXT;`);
}
async function remember(chat,user){if(!chat||!user||user.is_bot)return;await sql(`INSERT INTO members(chat_id,user_id,first_name,last_name,username) VALUES($1,$2,$3,$4,$5) ON CONFLICT(chat_id,user_id) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,username=EXCLUDED.username,last_seen=NOW()`,[chat.id,user.id,user.first_name||'',user.last_name||'',user.username||''])}
async function syncGroup(chat){if(!chat||!['supergroup','group'].includes(chat.type))return;await sql(`INSERT INTO groups(chat_id,title,username) VALUES($1,$2,$3) ON CONFLICT(chat_id) DO UPDATE SET title=EXCLUDED.title,username=COALESCE(EXCLUDED.username,groups.username),updated_at=NOW()`,[chat.id,chat.title||'그룹',chat.username||null]);}
async function refreshGroup(id){const c=await tg('getChat',{chat_id:id});await syncGroup(c);const me=await tg('getMe');const status=await tg('getChatMember',{chat_id:id,user_id:me.id});const count=await tg('getChatMemberCount',{chat_id:id});await sql('UPDATE groups SET member_count=$2,bot_promote=$3,bot_change=$4,updated_at=NOW() WHERE chat_id=$1',[id,count,Boolean(status.can_promote_members),Boolean(status.can_change_info)]);return status}
async function onUpdate(u){
 const msg=u.message||u.edited_message;
 if(msg?.chat?.type==='private'&&operators.has(String(msg.from?.id))&&msg.text?.startsWith('/start')){await tg('sendMessage',{chat_id:msg.chat.id,text:'🛡 비상 그룹 관리자 봇 연결 완료. 웹 관리 페이지에서 본인의 Telegram ID로 인증하세요.\n내 ID: '+msg.from.id});return}
 if(msg&&['supergroup','group'].includes(msg.chat?.type)){await syncGroup(msg.chat);await remember(msg.chat,msg.from);for(const m of msg.new_chat_members||[])await remember(msg.chat,m);if(msg.reply_to_message?.from)await remember(msg.chat,msg.reply_to_message.from);if(msg.new_chat_title)await syncGroup({...msg.chat,title:msg.new_chat_title});}
 if(u.chat_member){await syncGroup(u.chat_member.chat);await remember(u.chat_member.chat,u.chat_member.new_chat_member?.user)}
 if(u.my_chat_member){await syncGroup(u.my_chat_member.chat);try{await refreshGroup(u.my_chat_member.chat.id)}catch(e){console.error('bot membership refresh:',e.message)}}
}
app.post('/telegram/webhook',async(req,res)=>{if(!equal(req.get('x-telegram-bot-api-secret-token')||'',process.env.WEBHOOK_SECRET))return res.sendStatus(403);const u=req.body;if(!Number.isSafeInteger(u?.update_id))return res.sendStatus(400);try{const rows=await sql('INSERT INTO update_dedup(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id',[u.update_id]);if(rows.length){try{await onUpdate(u)}catch(err){await sql('DELETE FROM update_dedup WHERE update_id=$1',[u.update_id]);throw err}}return res.sendStatus(200)}catch(e){console.error('webhook:',e);return res.sendStatus(500)}});
function cookie(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>{const i=x.indexOf('=');return i<0?['','']:[x.slice(0,i).trim(),x.slice(i+1)]}))}
async function auth(req,res,next){try{const sid=cookie(req).sid||'';if(!/^[a-f0-9]{64}$/.test(sid))return res.status(401).json({error:'로그인이 필요합니다'});const hash=sign(sid);const rows=await sql('SELECT token_hash FROM admin_sessions WHERE token_hash=$1 AND expires_at>NOW()',[hash]);if(!rows.length)return res.status(401).json({error:'세션이 만료되었습니다'});req.operator='0';next()}catch(e){next(e)}}
app.post('/api/auth/login',async(req,res,next)=>{try{if(limited('login:'+requestIp(req),8))return res.status(429).json({error:'로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.'});const password=String(req.body.password||'');if(!equal(password,process.env.ADMIN_SECOND_PASSWORD))return res.status(403).json({error:'관리자 비밀번호가 올바르지 않습니다'});const sid=crypto.randomBytes(32).toString('hex');await sql("INSERT INTO admin_sessions(token_hash,expires_at) VALUES($1,NOW()+INTERVAL '30 days')",[sign(sid)]);res.setHeader('Set-Cookie',`sid=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`);res.json({ok:true})}catch(e){next(e)}});
app.post('/api/auth/logout',auth,async(req,res,next)=>{try{const sid=cookie(req).sid||'';await sql('DELETE FROM admin_sessions WHERE token_hash=$1',[sign(sid)]);res.setHeader('Set-Cookie','sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');res.json({ok:true})}catch(e){next(e)}});
app.get('/api/me',auth,(req,res)=>res.json({operator:req.operator}));
app.get('/api/groups',auth,async(req,res,next)=>{try{res.json(await sql('SELECT chat_id::text,title,username,member_count,bot_promote,bot_change,updated_at FROM groups ORDER BY updated_at DESC'))}catch(e){next(e)}});
app.post('/api/groups/:id/refresh',auth,async(req,res,next)=>{try{const id=safeId(req.params.id);if(!id)return res.sendStatus(400);await assertGroup(id);const status=await refreshGroup(id);res.json({ok:true,status:status.status,can_promote_members:!!status.can_promote_members,can_change_info:!!status.can_change_info})}catch(e){next(e)}});
async function assertGroup(id){const r=await sql('SELECT chat_id FROM groups WHERE chat_id=$1',[id]);if(!r.length)throw new Error('등록되지 않은 그룹입니다')}
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
app.get('/health',(_req,res)=>res.json({status:'ok'}));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)),'../public')));
app.use((e,req,res,next)=>{console.error(e);res.status(400).json({error:e.message||'요청 실패'})});
await init();const me=await tg('getMe');await tg('setWebhook',{url:base+'/telegram/webhook',secret_token:process.env.WEBHOOK_SECRET,allowed_updates:['message','edited_message','chat_member','my_chat_member'],drop_pending_updates:false});app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Admin bot started @'+me.username));
setInterval(()=>{for(const [id,v] of limits)if(v.every(t=>now()-t>600000))limits.delete(id);pool.query("DELETE FROM update_dedup WHERE created_at < NOW() - interval '7 days'").catch(console.error);pool.query('DELETE FROM admin_sessions WHERE expires_at<NOW()').catch(console.error)},3600000).unref();
