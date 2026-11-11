// Telegram-UID-only administration for the photo editor bot.
// Admins must be granted by trusted owners and every action rechecks UID.
const safeUid=v=>/^\d{1,19}$/.test(String(v??''))?String(v):null;
const owners=()=>new Set(String(process.env.IMAGE_ADMIN_UIDS||process.env.OPERATOR_TELEGRAM_IDS||'').split(',').map(s=>s.trim()).filter(x=>safeUid(x)));
export function createPhotoAdminOps(pool){
 async function init(){
  await pool.query(`CREATE TABLE IF NOT EXISTS image_bot_admins(
    uid BIGINT PRIMARY KEY,granted_by BIGINT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  for(const uid of owners())await pool.query('INSERT INTO image_bot_admins(uid,granted_by) VALUES($1,$1) ON CONFLICT DO NOTHING',[uid]);
 }
 const isOwner=uid=>owners().has(String(uid));
 async function isAdmin(uid){
  const id=safeUid(uid);if(!id)return false;
  if(isOwner(id))return true;
  return Boolean((await pool.query('SELECT 1 FROM image_bot_admins WHERE uid=$1',[id])).rowCount);
 }
 async function assertAdmin(actor){if(!await isAdmin(actor))throw Error('관리자 권한이 없는 UID입니다.');}
 function assertOwner(actor){if(!isOwner(actor))throw Error('최고 관리자만 권한을 변경할 수 있습니다.');}
 async function log(client,actor,action,uid,details={}){
  await client.query('INSERT INTO image_admin_audit(action,uid,details) VALUES($1,$2,$3)',[
    action,uid,JSON.stringify({actor:String(actor),...details})]);
 }
 async function overview(actor){
  await assertAdmin(actor);
  const [users,orders,usage]=await Promise.all([
   pool.query('SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE is_blocked)::int AS blocked FROM image_credit_accounts'),
   pool.query("SELECT COUNT(*)::int AS pending FROM image_shop_orders WHERE state='pending'"),
   pool.query("SELECT COUNT(*)::int AS used FROM image_credit_usage WHERE state='used'")
  ]);
  return {...users.rows[0],...orders.rows[0],...usage.rows[0]};
 }
 async function users(actor,query=''){
  await assertAdmin(actor);
  const q=String(query).trim().slice(0,80);
  const r=await pool.query(`SELECT uid::text,username,display_name,is_blocked,
   trial_total,paid_total,point_total,last_seen FROM image_credit_accounts
   WHERE $1='' OR uid::text LIKE $1||'%' OR username ILIKE '%'||$1||'%' OR display_name ILIKE '%'||$1||'%'
   ORDER BY last_seen DESC NULLS LAST LIMIT 12`,[q]);
  return r.rows;
 }
 async function user(actor,value){
  await assertAdmin(actor);const uid=safeUid(value);if(!uid)throw Error('올바른 UID를 입력해 주세요.');
  const r=await pool.query(`SELECT uid::text,username,display_name,is_blocked,trial_total,paid_total,point_total,
    (SELECT COUNT(*)::int FROM image_credit_usage u WHERE u.uid=a.uid AND u.state='used') AS used
    FROM image_credit_accounts a WHERE uid=$1`,[uid]);
  if(!r.rowCount)throw Error('등록된 UID가 없습니다.');
  const x=r.rows[0];
  const active=(await pool.query(`SELECT credit_type,state,COUNT(*)::int AS n FROM image_credit_usage
    WHERE uid=$1 AND (state='used' OR(state='reserved' AND expires_at>NOW()))
    GROUP BY credit_type,state`,[uid])).rows;
  const totalUsed=t=>active.filter(z=>z.credit_type===t).reduce((n,z)=>n+z.n,0);
  return {...x,trial_left:Math.max(0,x.trial_total-totalUsed('trial')),
   paid_left:Math.max(0,x.paid_total-totalUsed('paid'))+Math.max(0,x.point_total-totalUsed('point'))};
 }
 async function adjust(actor,value,kind,delta){
  await assertAdmin(actor);
  const uid=safeUid(value),n=Number(delta);
  if(!uid||!['trial','pass'].includes(kind)||!Number.isSafeInteger(n)||!n||Math.abs(n)>100000)
   throw Error('UID 또는 조정 횟수가 올바르지 않습니다.');
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   const account=(await c.query('SELECT trial_total,paid_total FROM image_credit_accounts WHERE uid=$1 FOR UPDATE',[uid])).rows[0];
   if(!account)throw Error('등록되지 않은 회원입니다.');
   const type=kind==='trial'?'trial':'paid',column=kind==='trial'?'trial_total':'paid_total';
   const used=(await c.query(`SELECT COUNT(*)::int AS n FROM image_credit_usage
      WHERE uid=$1 AND credit_type=$2 AND (state='used' OR(state='reserved' AND expires_at>NOW()))`,[uid,type])).rows[0].n;
   const after=account[column]+n;
   if(after<used||after>1000000)throw Error('완료·진행 중인 사용량보다 적게 설정할 수 없습니다.');
   await c.query('UPDATE image_credit_accounts SET '+column+'=$2,updated_at=NOW() WHERE uid=$1',[uid,after]);
   await log(c,actor,'telegram_'+kind+'_adjust',uid,{delta:n,before:account[column],after});
   await c.query('COMMIT');return {after};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 async function block(actor,value,blocked){
  await assertAdmin(actor);const uid=safeUid(value);if(!uid)throw Error('올바른 UID를 입력해 주세요.');
  if(await isAdmin(uid))throw Error('관리자 UID는 이 메뉴에서 정지할 수 없습니다.');
  const c=await pool.connect();
  try{await c.query('BEGIN');
   const r=await c.query('UPDATE image_credit_accounts SET is_blocked=$2,updated_at=NOW() WHERE uid=$1 RETURNING uid',[uid,Boolean(blocked)]);
   if(!r.rowCount)throw Error('등록되지 않은 회원입니다.');
   await log(c,actor,'telegram_block',uid,{blocked:Boolean(blocked)});
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 async function orders(actor){
  await assertAdmin(actor);
  const r=await pool.query(`SELECT id,uid::text,package_name,credits,price_krw,depositor,created_at
   FROM image_shop_orders WHERE state='pending' ORDER BY id ASC LIMIT 12`);
  return r.rows;
 }
 async function decide(actor,id,decision){
  await assertAdmin(actor);
  const num=Number(id);if(!Number.isSafeInteger(num)||num<1||!['approved','rejected'].includes(decision))throw Error('처리할 신청을 확인해 주세요.');
  const c=await pool.connect();
  let order;
  try{
   await c.query('BEGIN');
   order=(await c.query('SELECT * FROM image_shop_orders WHERE id=$1 FOR UPDATE',[num])).rows[0];
   if(!order||order.state!=='pending')throw Error('이미 처리됐거나 존재하지 않는 신청입니다.');
   if(decision==='approved'){
    await c.query('SELECT uid FROM image_credit_accounts WHERE uid=$1 FOR UPDATE',[order.uid]);
    await c.query('UPDATE image_credit_accounts SET paid_total=paid_total+$2,updated_at=NOW() WHERE uid=$1',[order.uid,order.credits]);
   }
   await c.query('UPDATE image_shop_orders SET state=$2,decided_at=NOW() WHERE id=$1',[num,decision]);
   await log(c,actor,'telegram_order_'+decision,order.uid,{order_id:num,passes:order.credits,amount:order.price_krw});
   await c.query('COMMIT');
   return {uid:String(order.uid),order_id:num,passes:order.credits,decision};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 async function packages(actor){
  await assertAdmin(actor);
  const [p,s]=await Promise.all([
   pool.query('SELECT id,name,credits,price_krw,active FROM image_shop_packages ORDER BY sort_order,id'),
   pool.query('SELECT enabled,instructions FROM image_shop_settings WHERE singleton=TRUE')
  ]);
  return {packages:p.rows,settings:s.rows[0]};
 }
 async function changePackage(actor,id,price,active){
  await assertAdmin(actor);const num=Number(id),amount=Number(price);
  if(!Number.isSafeInteger(num)||num<1||!Number.isSafeInteger(amount)||amount<0||amount>100000000||typeof active!=='boolean')
   throw Error('상품과 가격을 확인해 주세요.');
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   const r=await c.query('UPDATE image_shop_packages SET price_krw=$2,active=$3 WHERE id=$1 RETURNING id,name,credits,price_krw,active',[num,amount,active]);
   if(!r.rowCount)throw Error('상품이 없습니다.');
   await log(c,actor,'telegram_package',null,r.rows[0]);await c.query('COMMIT');return r.rows[0];
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 async function settings(actor,enabled,instructions){
  await assertAdmin(actor);
  if(typeof enabled!=='boolean')throw Error('판매 상태가 올바르지 않습니다.');
  if(enabled){
   const r=await pool.query('SELECT instructions FROM image_shop_settings WHERE singleton=TRUE');
   if(!r.rows[0]?.instructions.includes('입금'))throw Error('판매 활성화 전에 입금 안내를 설정해 주세요.');
   const count=(await pool.query('SELECT COUNT(*)::int AS n FROM image_shop_packages WHERE active=TRUE AND price_krw>0')).rows[0].n;
   if(!count)throw Error('가격과 판매 상품을 먼저 설정해 주세요.');
  }
  const c=await pool.connect();
  try{await c.query('BEGIN');
   await c.query('UPDATE image_shop_settings SET enabled=$1,updated_at=NOW() WHERE singleton=TRUE',[enabled]);
   await log(c,actor,'telegram_sale_toggle',null,{enabled});
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 async function instructions(actor,value){
  await assertAdmin(actor);
  const v=String(value||'').trim();
  if(v.length<6||v.length>900||!v.includes('입금'))throw Error('입금 방법을 포함한 안내 문구(6~900자)를 입력해 주세요.');
  const c=await pool.connect();
  try{await c.query('BEGIN');
   await c.query('UPDATE image_shop_settings SET instructions=$1,updated_at=NOW() WHERE singleton=TRUE',[v]);
   await log(c,actor,'telegram_shop_instructions',null,{length:v.length});
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 async function admins(actor){
  await assertAdmin(actor);
  const r=await pool.query('SELECT uid::text,granted_by::text,created_at FROM image_bot_admins ORDER BY created_at');
  return {owners:[...owners()],assigned:r.rows};
 }
 async function grant(actor,value){
  assertOwner(actor);const uid=safeUid(value);if(!uid)throw Error('등록할 관리자 UID를 입력해 주세요.');
  const c=await pool.connect();
  try{await c.query('BEGIN');
   await c.query('INSERT INTO image_bot_admins(uid,granted_by) VALUES($1,$2) ON CONFLICT(uid) DO NOTHING',[uid,actor]);
   await log(c,actor,'telegram_admin_grant',uid);await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 async function revoke(actor,value){
  assertOwner(actor);const uid=safeUid(value);
  if(!uid)throw Error('올바른 UID를 입력해 주세요.');
  if(isOwner(uid))throw Error('최고 관리자는 환경변수에서만 권한을 변경할 수 있습니다.');
  const c=await pool.connect();
  try{await c.query('BEGIN');
   await c.query('DELETE FROM image_bot_admins WHERE uid=$1',[uid]);
   await log(c,actor,'telegram_admin_revoke',uid);await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 return {init,isAdmin,isOwner,overview,users,user,adjust,block,orders,decide,packages,
  changePackage,settings,instructions,admins,grant,revoke};
}
