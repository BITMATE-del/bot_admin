// Durable UID-scoped edit credits and one-time trial migration.
import crypto from 'node:crypto';

const trialRaw=Number(process.env.IMAGE_TRIAL_CREDITS??1);
export const trialCredits=Number.isSafeInteger(trialRaw)&&trialRaw>=0&&trialRaw<=1000?trialRaw:1;

export function createImageCredits(pool){
 async function init(){
  await pool.query(`CREATE TABLE IF NOT EXISTS image_credit_accounts(
   uid BIGINT PRIMARY KEY, trial_total INTEGER NOT NULL DEFAULT 0 CHECK(trial_total>=0),
   paid_total INTEGER NOT NULL DEFAULT 0 CHECK(paid_total>=0),
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
   ALTER TABLE image_credit_accounts ADD COLUMN IF NOT EXISTS point_total INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE image_credit_accounts ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE;
   ALTER TABLE image_credit_accounts ADD COLUMN IF NOT EXISTS username TEXT NOT NULL DEFAULT '';
   ALTER TABLE image_credit_accounts ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';
   ALTER TABLE image_credit_accounts ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT NOW();
   CREATE TABLE IF NOT EXISTS image_credit_usage(
    id UUID PRIMARY KEY,uid BIGINT NOT NULL REFERENCES image_credit_accounts(uid),
    credit_type TEXT NOT NULL CHECK(credit_type IN ('trial','paid','point')),
    state TEXT NOT NULL CHECK(state IN ('reserved','used','released')),
    source TEXT NOT NULL DEFAULT 'edit',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,finished_at TIMESTAMPTZ);
   ALTER TABLE image_credit_usage ADD COLUMN IF NOT EXISTS request_summary TEXT NOT NULL DEFAULT '';
   CREATE INDEX IF NOT EXISTS image_credit_usage_uid_idx ON image_credit_usage(uid,state,expires_at);
   ALTER TABLE image_credit_usage DROP CONSTRAINT IF EXISTS image_credit_usage_credit_type_check;
   ALTER TABLE image_credit_usage ADD CONSTRAINT image_credit_usage_credit_type_check CHECK(credit_type IN ('trial','paid','point'));
   CREATE TABLE IF NOT EXISTS image_system_migrations(id TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  // Older users were granted three trial edits. Reduce these grants to one
  // exactly once, preserving used historical entries and explicit admin edits.
  await pool.query(`WITH once AS (
    INSERT INTO image_system_migrations(id) VALUES('trial_three_to_one_20261111')
    ON CONFLICT DO NOTHING RETURNING id
   ) UPDATE image_credit_accounts SET trial_total=1,updated_at=NOW()
   WHERE trial_total=3 AND EXISTS(SELECT 1 FROM once)`);
 }
 const uidOf=value=>{
  const v=String(value??'');if(!/^\d{1,19}$/.test(v))throw Error('올바른 텔레그램 UID가 아니야.');return v;
 };
 async function ensure(c,uid){
  await c.query('INSERT INTO image_credit_accounts(uid,trial_total) VALUES($1,$2) ON CONFLICT(uid) DO NOTHING',[uid,trialCredits]);
 }
 async function summaryWith(c,uid){
  const row=(await c.query('SELECT trial_total,paid_total,point_total,is_blocked,username,display_name,created_at,last_seen FROM image_credit_accounts WHERE uid=$1',[uid])).rows[0];
  const uses=(await c.query(`SELECT credit_type,state,COUNT(*)::int AS count FROM image_credit_usage
   WHERE uid=$1 AND (state='used' OR (state='reserved' AND expires_at>NOW()))
   GROUP BY credit_type,state`,[uid])).rows;
  const n={trial_used:0,paid_used:0,point_used:0,trial_reserved:0,paid_reserved:0,point_reserved:0};
  for(const x of uses)n[x.credit_type+'_'+(x.state==='used'?'used':'reserved')]=x.count;
  const b={};
  for(const type of ['trial','paid','point']){
   b[type+'_left']=Math.max(0,row[type+'_total']-n[type+'_used']-n[type+'_reserved']);
  }
  return {uid,...row,...b,remaining:b.trial_left+b.paid_left+b.point_left,
   used:n.trial_used+n.paid_used+n.point_used,
   reserved:n.trial_reserved+n.paid_reserved+n.point_reserved,
   used_by_type:{trial:n.trial_used,paid:n.paid_used,point:n.point_used},
   reserved_by_type:{trial:n.trial_reserved,paid:n.paid_reserved,point:n.point_reserved}};
 }
 async function status(value){
  const uid=uidOf(value),c=await pool.connect();
  try{await ensure(c,uid);return await summaryWith(c,uid);}finally{c.release();}
 }
 async function touch(value,from={}){
  const uid=uidOf(value);
  await pool.query(`INSERT INTO image_credit_accounts(uid,trial_total,username,display_name)
   VALUES($1,$2,$3,$4) ON CONFLICT(uid) DO UPDATE SET
   username=EXCLUDED.username,display_name=EXCLUDED.display_name,last_seen=NOW()`,[
    uid,trialCredits,String(from.username||'').slice(0,100),
    [from.first_name,from.last_name].filter(Boolean).join(' ').slice(0,140)]);
 }
 async function reserve(value,source='edit',summary=''){
  const uid=uidOf(value),c=await pool.connect();
  try{
   await c.query('BEGIN');await ensure(c,uid);
   await c.query('SELECT uid FROM image_credit_accounts WHERE uid=$1 FOR UPDATE',[uid]);
   const balance=await summaryWith(c,uid);
   if(balance.is_blocked){await c.query('COMMIT');return {ok:false,reason:'blocked',balance};}
   const type=balance.trial_left>0?'trial':balance.point_left>0?'point':balance.paid_left>0?'paid':null;
   if(!type){await c.query('COMMIT');return {ok:false,reason:'empty',balance};}
   const id=crypto.randomUUID();
   await c.query(`INSERT INTO image_credit_usage(id,uid,credit_type,state,source,request_summary,expires_at)
    VALUES($1,$2,$3,'reserved',$4,$5,NOW()+INTERVAL '45 minutes')`,
    [id,uid,type,String(source).slice(0,40),String(summary).slice(0,200)]);
   await c.query('COMMIT');return {ok:true,id,credit_type:type};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 async function finish(id,state){
  if(!/^[0-9a-f-]{36}$/i.test(String(id)))return;
  await pool.query(`UPDATE image_credit_usage SET state=$2,finished_at=NOW()
   WHERE id=$1 AND state='reserved'`,[id,state]);
 }
 return {init,status,touch,reserve,consume:id=>finish(id,'used'),release:id=>finish(id,'released'),uidOf};
}
