import {createImageCredits,trialCredits} from './image-credits.js';
import {createPhotoAdminOps} from './photo-admin-ops.js';
const safeUid=value=>/^\d{1,19}$/.test(String(value||''))?String(value):null;

export function mountPhotoAdmin(app,pool){
 const credits=createImageCredits(pool);
 const telegramAdmin=createPhotoAdminOps(pool);
 const ensure=async(uid)=>pool.query('INSERT INTO image_credit_accounts(uid,trial_total) VALUES($1,$2) ON CONFLICT(uid) DO NOTHING',[uid,trialCredits]);
 async function init(){
  await credits.init();
  await telegramAdmin.init();
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
  await pool.query(`
    ALTER TABLE image_shop_packages ADD COLUMN IF NOT EXISTS price_usdt NUMERIC(14,4) NOT NULL DEFAULT 0;
    ALTER TABLE image_shop_orders ADD COLUMN IF NOT EXISTS payment_asset TEXT NOT NULL DEFAULT 'USDT';
    ALTER TABLE image_shop_orders ADD COLUMN IF NOT EXISTS payment_amount NUMERIC(22,6);
    ALTER TABLE image_shop_orders ADD COLUMN IF NOT EXISTS payment_address TEXT NOT NULL DEFAULT '';
    ALTER TABLE image_shop_orders ADD COLUMN IF NOT EXISTS price_usdt NUMERIC(14,4) NOT NULL DEFAULT 0;
    ALTER TABLE image_shop_settings ADD COLUMN IF NOT EXISTS usdt_trc20_address TEXT NOT NULL DEFAULT '';
    ALTER TABLE image_shop_settings ADD COLUMN IF NOT EXISTS trx_address TEXT NOT NULL DEFAULT '';
    ALTER TABLE image_shop_settings ADD COLUMN IF NOT EXISTS trx_per_usdt NUMERIC(16,6);
    ALTER TABLE image_shop_settings ADD COLUMN IF NOT EXISTS payment_instructions TEXT NOT NULL DEFAULT '';
  `);
  // Replace legacy unused packages once; preserve historical order snapshots.
  const migration=await pool.query(`INSERT INTO image_system_migrations(id)
    VALUES('photo_shop_usdt_packages_20261111') ON CONFLICT DO NOTHING RETURNING id`);
  if(migration.rowCount){
    await pool.query('UPDATE image_shop_packages SET active=FALSE');
    await pool.query(`INSERT INTO image_shop_packages(name,credits,price_krw,price_usdt,active,sort_order)
      VALUES ('이용권 10매',10,0,25,TRUE,1),
             ('이용권 50매',50,0,120,TRUE,2),
             ('이용권 100매',100,0,220,TRUE,3)`);
  }
  const existing=await pool.query('SELECT COUNT(*)::int AS n FROM image_shop_packages');
  if(!existing.rows[0].n)await pool.query(`INSERT INTO image_shop_packages(name,credits,price_krw,active,sort_order)
   VALUES ('체험 연장 5회',5,0,FALSE,1),('기본 10회',10,0,FALSE,2),('집중 30회',30,0,FALSE,3)`);
 }
 // Former password-only web administration is retired. UID-verified Telegram
 // administration is the sole supported management surface.
 app.use(['/photo-admin','/api/photo-admin'],(_req,res)=>{
  res.status(410).set('Cache-Control','no-store').json({error:'관리자 기능은 포토샵봇의 /관리자 메뉴로 이동했습니다.'});
 });
 async function storefront(){
  const [settings,packs]=await Promise.all([
   pool.query('SELECT enabled,usdt_trc20_address,trx_address,trx_per_usdt,payment_instructions FROM image_shop_settings WHERE singleton=TRUE'),
   pool.query('SELECT id,name,credits,price_usdt FROM image_shop_packages WHERE active=TRUE AND price_usdt>0 ORDER BY sort_order,id')]);
  const shop=settings.rows[0]||{enabled:false};
  const methods=[];
  if(/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(shop.usdt_trc20_address||''))methods.push('USDT');
  if(/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(shop.trx_address||'')&&Number(shop.trx_per_usdt)>0)methods.push('TRX');
  return {enabled:Boolean(shop.enabled&&methods.length),methods,packages:packs.rows};
 }
 async function order(uid,packageId,asset='USDT'){
  const c=await pool.connect();
  try{
   await c.query('BEGIN');await ensureTx(c,uid);
   const account=(await c.query('SELECT is_blocked FROM image_credit_accounts WHERE uid=$1 FOR UPDATE',[uid])).rows[0];
   if(account?.is_blocked)throw Error('이용이 제한된 계정은 구매 신청을 할 수 없습니다.');
   const shop=(await c.query('SELECT enabled,usdt_trc20_address,trx_address,trx_per_usdt,payment_instructions FROM image_shop_settings WHERE singleton=TRUE')).rows[0];
   if(!shop?.enabled)throw Error('현재 이용권 판매가 준비 중입니다.');
   const pack=(await c.query('SELECT * FROM image_shop_packages WHERE id=$1 AND active=TRUE AND price_usdt>0',[packageId])).rows[0];
   if(!pack)throw Error('해당 상품은 판매 중이 아닙니다.');
   if(!['USDT','TRX'].includes(asset))throw Error('지원하지 않는 결제 통화입니다.');
   const address=asset==='USDT'?shop.usdt_trc20_address:shop.trx_address;
   const rate=Number(shop.trx_per_usdt);
   if(!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address||''))throw Error('해당 결제 통화의 지갑 주소가 등록되지 않았습니다.');
   if(asset==='TRX'&&(!Number.isFinite(rate)||rate<=0))throw Error('관리자가 TRX 환산율을 설정하지 않았습니다.');
   const existing=(await c.query("SELECT id FROM image_shop_orders WHERE uid=$1 AND state='pending' ORDER BY id DESC LIMIT 1",[uid])).rows[0];
   if(existing)throw Error('이미 입금 확인 대기 중인 신청 #'+existing.id+'이 있습니다.');
   const usdt=Number(pack.price_usdt);
   const amount=asset==='USDT'?usdt:Math.ceil(usdt*rate*1e6)/1e6;
   const result=await c.query(`INSERT INTO image_shop_orders(
     uid,package_id,package_name,credits,price_krw,price_usdt,payment_asset,payment_amount,payment_address)
     VALUES($1,$2,$3,$4,0,$5,$6,$7,$8) RETURNING id`,[
      uid,pack.id,pack.name,pack.credits,usdt,asset,amount,address]);
   await c.query('COMMIT');
   return {id:result.rows[0].id,credits:pack.credits,name:pack.name,price_usdt:usdt,
     payment_asset:asset,payment_amount:amount,payment_address:address,
     instructions:shop.payment_instructions||''};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 async function ordersFor(uid){
  const id=safeUid(uid);if(!id)throw Error('UID가 올바르지 않습니다.');
  const r=await pool.query(`SELECT id,package_name,credits,price_usdt,payment_asset,payment_amount,state,created_at,decided_at
   FROM image_shop_orders WHERE uid=$1 ORDER BY id DESC LIMIT 10`,[id]);
  return r.rows;
 }
 return {init,storefront,order,ordersFor,credits,telegramAdmin};
}
