import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createImageCredits,trialCredits} from './image-credits.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const pw=()=>String(process.env.IMAGE_ADMIN_PASSWORD||process.env.ADMIN_SECOND_PASSWORD||'');
const secret=()=>String(process.env.SESSION_SECRET||'');
const originOk=req=>!req.get('origin')||new URL(req.get('origin')).host===req.get('host');
const parsePositive=(value,max=1000000)=>{const v=Number(value);return Number.isSafeInteger(v)&&v>=0&&v<=max?v:null};
const safeUid=x=>/^\d{1,19}$/.test(String(x||''))?String(x):null;
const hmac=x=>crypto.createHmac('sha256',secret()).update(x).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const cookie=req=>Object.fromEntries(String(req.get('cookie')||'').split(';').map(p=>p.trim().split('=').slice(0,2))).photo_admin||'';
const cookieFlags=req=>'; Path=/photo-admin; HttpOnly; SameSite=Strict'+(req.secure||req.get('x-forwarded-proto')==='https'?'; Secure':'');
const recentLogins=new Map();

export function mountPhotoAdmin(app,pool){
 const credits=createImageCredits(pool);
 const ensure=async(uid)=>pool.query('INSERT INTO image_credit_accounts(uid,trial_total) VALUES($1,$2) ON CONFLICT(uid) DO NOTHING',[uid,trialCredits]);
 async function init(){
  await credits.init();
  await pool.query(`CREATE TABLE IF NOT EXISTS image_shop_settings(
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    instructions TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
   INSERT INTO image_shop_settings(singleton) VALUES(TRUE) ON CONFLICT DO NOTHING;
   CREATE TABLE IF NOT EXISTS image_shop_packages(
    id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,credits INTEGER NOT NULL CHECK(credits>0 AND credits<=100000),
    price_krw INTEGER NOT NULL DEFAULT 0 CHECK(price_krw>=0),
    active BOOLEAN NOT NULL DEFAULT FALSE,sort_order INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS image_shop_orders(
    id BIGSERIAL PRIMARY KEY,uid BIGINT NOT NULL REFERENCES image_credit_accounts(uid),
    package_id BIGINT REFERENCES image_shop_packages(id),
    package_name TEXT NOT NULL,credits INTEGER NOT NULL CHECK(credits>0),
    price_krw INTEGER NOT NULL CHECK(price_krw>=0),
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),
    depositor TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at TIMESTAMPTZ,decision_note TEXT NOT NULL DEFAULT '');
   CREATE INDEX IF NOT EXISTS image_shop_orders_uid_idx ON image_shop_orders(uid,created_at DESC);
   CREATE TABLE IF NOT EXISTS image_admin_audit(
    id BIGSERIAL PRIMARY KEY,action TEXT NOT NULL,uid BIGINT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  const existing=await pool.query('SELECT COUNT(*)::int AS n FROM image_shop_packages');
  if(!existing.rows[0].n)await pool.query(`INSERT INTO image_shop_packages(name,credits,price_krw,active,sort_order)
   VALUES ('체험 연장 5회',5,0,FALSE,1),('기본 10회',10,0,FALSE,2),('집중 30회',30,0,FALSE,3)`);
 }
 const error=(res,e)=>{console.error('photo admin:',e.message);res.status(400).json({error:e.message||'처리 실패'})};
 const requireAdmin=(req,res,next)=>{
  const [expires,nonce,signature]=cookie(req).split('.');
  if(!expires||!nonce||!signature||!/^\d+$/.test(expires) || Number(expires)<=Date.now() ||
   !equal(signature,hmac(expires+'.'+nonce)))return res.status(401).json({error:'로그인이 필요합니다.'});
  next();
 };
 const checkPost=(req,res,next)=>{
  try{if(!originOk(req))return res.status(403).json({error:'잘못된 요청 출처'});}catch{return res.status(403).json({error:'잘못된 요청 출처'});}
  if(!req.is('application/json'))return res.status(415).json({error:'JSON 요청만 허용합니다.'});
  next();
 };
 app.get('/photo-admin',(req,res)=>{
  res.set('Cache-Control','no-store');
  res.sendFile(path.join(here,'../public/photo-admin.html'));
 });
 app.post('/api/photo-admin/login',checkPost,async(req,res)=>{
  const ip=String(req.ip||'unknown'),now=Date.now();
  const visits=(recentLogins.get(ip)||[]).filter(t=>now-t<600000);
  visits.push(now);recentLogins.set(ip,visits);
  if(visits.length>8)return res.status(429).json({error:'로그인 시도가 많습니다. 잠시 뒤 다시 시도하세요.'});
  const entered=String(req.body?.password||'');
  if(!pw()||!equal(hmac(entered),hmac(pw())))return res.status(401).json({error:'비밀번호가 올바르지 않습니다.'});
  recentLogins.delete(ip);
  const expires=Date.now()+8*3600*1000,nonce=crypto.randomBytes(12).toString('hex');
  res.set('Set-Cookie','photo_admin='+[expires,nonce,hmac(expires+'.'+nonce)].join('.')+cookieFlags(req));
  res.json({ok:true});
 });
 app.get('/api/photo-admin/session',requireAdmin,(_req,res)=>res.json({ok:true}));
 app.post('/api/photo-admin/logout',checkPost,(_req,res)=>{
  res.set('Set-Cookie','photo_admin=; Max-Age=0'+cookieFlags(_req));res.json({ok:true});
 });
 app.get('/api/photo-admin/summary',requireAdmin,async(req,res)=>{
  try{
   const [members,orders,usage,settings]=await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS members,COUNT(*) FILTER(WHERE is_blocked)::int AS blocked,
     COALESCE(SUM(point_total),0)::bigint AS total_points FROM image_credit_accounts`),
    pool.query(`SELECT state,COUNT(*)::int AS n FROM image_shop_orders GROUP BY state`),
    pool.query(`SELECT COUNT(*)::int AS completed FROM image_credit_usage WHERE state='used'`),
    pool.query('SELECT enabled,instructions FROM image_shop_settings WHERE singleton=TRUE')
   ]);
   res.json({members:members.rows[0],orders:orders.rows,usage:usage.rows[0],shop:settings.rows[0]});
  }catch(e){error(res,e);}
 });
 app.get('/api/photo-admin/users',requireAdmin,async(req,res)=>{
  try{
   const q=String(req.query.q||'').trim().slice(0,100);
   const result=await pool.query(`SELECT uid::text,username,display_name,is_blocked,trial_total,paid_total,point_total,created_at,last_seen,
   (SELECT COUNT(*)::int FROM image_credit_usage u WHERE u.uid=a.uid AND u.state='used') AS used
   FROM image_credit_accounts a WHERE $1='' OR a.uid::text LIKE $1||'%' OR username ILIKE '%'||$1||'%' OR display_name ILIKE '%'||$1||'%'
   ORDER BY last_seen DESC NULLS LAST,uid DESC LIMIT 100`,[q]);res.json({items:result.rows});
  }catch(e){error(res,e);}
 });
 app.get('/api/photo-admin/users/:uid',requireAdmin,async(req,res)=>{
  try{
   const uid=safeUid(req.params.uid);if(!uid)return res.sendStatus(400);
   const [balance,history,orders]=await Promise.all([
    credits.status(uid),
    pool.query(`SELECT id,credit_type,state,source,created_at,finished_at FROM image_credit_usage
     WHERE uid=$1 ORDER BY created_at DESC LIMIT 50`,[uid]),
    pool.query(`SELECT id,package_name,credits,price_krw,state,depositor,created_at,decided_at
     FROM image_shop_orders WHERE uid=$1 ORDER BY id DESC LIMIT 30`,[uid])
   ]);
   res.json({balance,history:history.rows,orders:orders.rows});
  }catch(e){error(res,e);}
 });
 app.post('/api/photo-admin/users/:uid',requireAdmin,checkPost,async(req,res)=>{
  const uid=safeUid(req.params.uid),action=String(req.body?.action||'');
  if(!uid||!['trial','points','block'].includes(action))return res.status(400).json({error:'잘못된 요청'});
  const client=await pool.connect();
  try{
   await client.query('BEGIN');await ensureTx(client,uid);
   const account=(await client.query('SELECT * FROM image_credit_accounts WHERE uid=$1 FOR UPDATE',[uid])).rows[0];
   let details={};
   if(action==='block'){
    if(typeof req.body.blocked!=='boolean')throw Error('차단 여부가 필요합니다.');
    await client.query('UPDATE image_credit_accounts SET is_blocked=$2,updated_at=NOW() WHERE uid=$1',[uid,req.body.blocked]);
    details={blocked:req.body.blocked};
   }else{
    const value=Number(req.body.value);
    if(!Number.isSafeInteger(value)||value< -100000||value>100000)throw Error('조정 값이 올바르지 않습니다.');
    const column=action==='trial'?'trial_total':'point_total';
    const current=account[column];
    const target=current+value;
    const usageType=action==='trial'?'trial':'point';
    const minRow=(await client.query(`SELECT COUNT(*)::int AS count FROM image_credit_usage
      WHERE uid=$1 AND credit_type=$2 AND (state='used' OR (state='reserved' AND expires_at>NOW()))`,[uid,usageType])).rows[0];
    if(target<minRow.count||target>1000000)throw Error('사용 완료·진행 중인 횟수보다 적게 설정할 수 없습니다.');
    await client.query('UPDATE image_credit_accounts SET '+column+'=$2,updated_at=NOW() WHERE uid=$1',[uid,target]);
    details={action,change:value,before:current,after:target};
   }
   await client.query('INSERT INTO image_admin_audit(action,uid,details) VALUES($1,$2,$3)',[action,uid,JSON.stringify(details)]);
   await client.query('COMMIT');res.json({ok:true,balance:await credits.status(uid)});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});error(res,e);}finally{client.release();}
 });
 async function ensureTx(client,uid){await client.query('INSERT INTO image_credit_accounts(uid,trial_total) VALUES($1,$2) ON CONFLICT DO NOTHING',[uid,trialCredits]);}
 app.get('/api/photo-admin/packages',requireAdmin,async(req,res)=>{
  try{const [packs,settings]=await Promise.all([pool.query('SELECT * FROM image_shop_packages ORDER BY sort_order,id'),pool.query('SELECT enabled,instructions FROM image_shop_settings WHERE singleton=TRUE')]);res.json({items:packs.rows,settings:settings.rows[0]});}catch(e){error(res,e);}
 });
 app.post('/api/photo-admin/packages/:id',requireAdmin,checkPost,async(req,res)=>{
  try{
   const id=Number(req.params.id),creditsCount=parsePositive(req.body?.credits,100000),price=parsePositive(req.body?.price_krw,100000000);
   const name=String(req.body?.name||'').trim().slice(0,70);
   if(!Number.isSafeInteger(id)||id<1||!name||!creditsCount||price===null||typeof req.body.active!=='boolean')throw Error('상품 값을 확인해 주세요.');
   const r=await pool.query('UPDATE image_shop_packages SET name=$2,credits=$3,price_krw=$4,active=$5 WHERE id=$1 RETURNING *',[id,name,creditsCount,price,req.body.active]);
   if(!r.rowCount)throw Error('상품이 존재하지 않습니다.');
   await pool.query('INSERT INTO image_admin_audit(action,details) VALUES($1,$2)',['package_update',JSON.stringify(r.rows[0])]);
   res.json({ok:true,item:r.rows[0]});
  }catch(e){error(res,e);}
 });
 app.post('/api/photo-admin/settings',requireAdmin,checkPost,async(req,res)=>{
  try{
   const instructions=String(req.body?.instructions||'').trim().slice(0,900);
   if(typeof req.body?.enabled!=='boolean')throw Error('판매 상태를 선택해 주세요.');
   if(req.body.enabled&&(!instructions||!instructions.includes('입금')))throw Error('판매 활성화 전 입금 안내 문구를 입력해 주세요.');
   await pool.query('UPDATE image_shop_settings SET enabled=$1,instructions=$2,updated_at=NOW() WHERE singleton=TRUE',[req.body.enabled,instructions]);
   await pool.query('INSERT INTO image_admin_audit(action,details) VALUES($1,$2)',['shop_settings',JSON.stringify({enabled:req.body.enabled})]);
   res.json({ok:true});
  }catch(e){error(res,e);}
 });
 app.get('/api/photo-admin/orders',requireAdmin,async(req,res)=>{
  try{const state=String(req.query.state||'pending');const rows=await pool.query(`SELECT id,uid::text,package_name,credits,price_krw,state,depositor,created_at,decided_at,decision_note
     FROM image_shop_orders WHERE ($1='all' OR state=$1) ORDER BY id DESC LIMIT 200`,[state]);res.json({items:rows.rows});}catch(e){error(res,e);}
 });
 app.post('/api/photo-admin/orders/:id/decide',requireAdmin,checkPost,async(req,res)=>{
  const id=Number(req.params.id),decision=String(req.body?.decision||'');
  if(!Number.isSafeInteger(id)||id<1||!['approved','rejected'].includes(decision))return res.sendStatus(400);
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const order=(await client.query('SELECT * FROM image_shop_orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!order)throw Error('신청이 존재하지 않습니다.');
   if(order.state!=='pending')throw Error('이미 처리된 주문입니다.');
   if(decision==='approved'){
    await client.query('SELECT uid FROM image_credit_accounts WHERE uid=$1 FOR UPDATE',[order.uid]);
    await client.query('UPDATE image_credit_accounts SET point_total=point_total+$2,updated_at=NOW() WHERE uid=$1',[order.uid,order.credits]);
   }
   await client.query('UPDATE image_shop_orders SET state=$2,decided_at=NOW(),decision_note=$3 WHERE id=$1',[id,decision,String(req.body?.note||'').slice(0,200)]);
   await client.query('INSERT INTO image_admin_audit(action,uid,details) VALUES($1,$2,$3)',[
    'order_'+decision,order.uid,JSON.stringify({order_id:id,credits:order.credits,price_krw:order.price_krw})]);
   await client.query('COMMIT');
   // Notify only after committing the balance change. Notification failures
   // never roll back or repeat a completed financial action.
   let notified=false;
   if(process.env.IMAGE_BOT_TOKEN){
    try{
     const caption=decision==='approved'
      ?'✅ 이용권 구매 승인\\n신청 #'+id+'\\n'+order.package_name+' / '+order.credits+'P가 지급됐어.\\n/잔여횟수 로 확인해 줘.'
      :'❌ 이용권 구매 신청 거절\\n신청 #'+id+'\\n문의사항이 있으면 관리자에게 연락해 줘.';
     const response=await fetch('https://api.telegram.org/bot'+process.env.IMAGE_BOT_TOKEN+'/sendMessage',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({chat_id:String(order.uid),text:caption}),signal:AbortSignal.timeout(12000)
     });
     notified=Boolean((await response.json()).ok);
    }catch(e){console.warn('order notification failed:',e.message)}
   }
   res.json({ok:true,uid:String(order.uid),credits:order.credits,state:decision,notified});
  }catch(e){await client.query('ROLLBACK').catch(()=>{});error(res,e);}finally{client.release();}
 });
 app.get('/api/photo-admin/audit',requireAdmin,async(req,res)=>{
  try{const r=await pool.query('SELECT id,action,uid::text,details,created_at FROM image_admin_audit ORDER BY id DESC LIMIT 100');res.json({items:r.rows});}catch(e){error(res,e);}
 });
 async function storefront(){
  const [settings,packs]=await Promise.all([
   pool.query('SELECT enabled,instructions FROM image_shop_settings WHERE singleton=TRUE'),
   pool.query('SELECT id,name,credits,price_krw FROM image_shop_packages WHERE active=TRUE AND price_krw>0 ORDER BY sort_order,id')]);
  const shop=settings.rows[0]||{enabled:false,instructions:''};
  return {enabled:Boolean(shop.enabled&&shop.instructions),instructions:shop.instructions,packages:packs.rows};
 }
 async function order(uid,packageId,depositor=''){
  const c=await pool.connect();
  try{
   await c.query('BEGIN');await ensureTx(c,uid);
   const account=(await c.query('SELECT is_blocked FROM image_credit_accounts WHERE uid=$1 FOR UPDATE',[uid])).rows[0];
   if(account?.is_blocked)throw Error('이용이 제한된 계정은 구매 신청을 할 수 없습니다.');
   const shop=(await c.query('SELECT enabled,instructions FROM image_shop_settings WHERE singleton=TRUE')).rows[0];
   if(!shop?.enabled||!shop.instructions)throw Error('현재 이용권 판매가 준비 중입니다.');
   const pack=(await c.query('SELECT * FROM image_shop_packages WHERE id=$1 AND active=TRUE AND price_krw>0',[packageId])).rows[0];
   if(!pack)throw Error('해당 상품은 판매 중이 아닙니다.');
   const existing=(await c.query(`SELECT id FROM image_shop_orders WHERE uid=$1 AND state='pending' ORDER BY id DESC LIMIT 1`,[uid])).rows[0];
   if(existing)throw Error('이미 대기 중인 신청 #'+existing.id+'이 있습니다.');
   const result=await c.query(`INSERT INTO image_shop_orders(uid,package_id,package_name,credits,price_krw,depositor)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[uid,pack.id,pack.name,pack.credits,pack.price_krw,String(depositor).slice(0,60)]);
   await c.query('COMMIT');
   return {id:result.rows[0].id,credits:pack.credits,name:pack.name,price_krw:pack.price_krw,instructions:shop.instructions};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 async function ordersFor(uid){
  const id=safeUid(uid);if(!id)throw Error('UID가 올바르지 않습니다.');
  const r=await pool.query(`SELECT id,package_name,credits,price_krw,state,created_at,decided_at
   FROM image_shop_orders WHERE uid=$1 ORDER BY id DESC LIMIT 10`,[id]);
  return r.rows;
 }
 return {init,storefront,order,ordersFor,credits};
}
