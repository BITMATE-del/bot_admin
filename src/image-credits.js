// UID-scoped usage ledger. Reservations prevent concurrent requests from
// spending the same credit; only successfully delivered outputs are consumed.
import crypto from 'node:crypto';

const trialRaw=Number(process.env.IMAGE_TRIAL_CREDITS??3);
export const trialCredits=Number.isSafeInteger(trialRaw)&&trialRaw>=0&&trialRaw<=1000?trialRaw:3;
const leaseMinutes=45;
export function createImageCredits(pool){
  async function init(){
    await pool.query(`CREATE TABLE IF NOT EXISTS image_credit_accounts(
      uid BIGINT PRIMARY KEY,
      trial_total INTEGER NOT NULL DEFAULT 0 CHECK(trial_total>=0),
      paid_total INTEGER NOT NULL DEFAULT 0 CHECK(paid_total>=0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS image_credit_usage(
      id UUID PRIMARY KEY,uid BIGINT NOT NULL REFERENCES image_credit_accounts(uid),
      credit_type TEXT NOT NULL CHECK(credit_type IN ('trial','paid')),
      state TEXT NOT NULL CHECK(state IN ('reserved','used','released')),
      source TEXT NOT NULL DEFAULT 'edit',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS image_credit_usage_uid_idx ON image_credit_usage(uid,state,expires_at);`);
  }
  const uidOf=value=>{
    const v=String(value??'');
    if(!/^\d{1,19}$/.test(v))throw Error('올바른 텔레그램 UID가 아니야.');
    return v;
  };
  async function ensure(client,uid){
    await client.query('INSERT INTO image_credit_accounts(uid,trial_total) VALUES($1,$2) ON CONFLICT(uid) DO NOTHING',[uid,trialCredits]);
  }
  async function summaryWith(client,uid){
    const a=(await client.query('SELECT trial_total,paid_total FROM image_credit_accounts WHERE uid=$1',[uid])).rows[0];
    const usage=(await client.query(`
      SELECT credit_type,state,COUNT(*)::int AS count FROM image_credit_usage
      WHERE uid=$1 AND (state='used' OR (state='reserved' AND expires_at>NOW()))
      GROUP BY credit_type,state`,[uid])).rows;
    const counts={trial_used:0,paid_used:0,trial_reserved:0,paid_reserved:0};
    for(const x of usage)counts[x.credit_type+'_'+(x.state==='used'?'used':'reserved')]=x.count;
    const trialLeft=Math.max(0,a.trial_total-counts.trial_used-counts.trial_reserved);
    const paidLeft=Math.max(0,a.paid_total-counts.paid_used-counts.paid_reserved);
    return {uid,trial_total:a.trial_total,paid_total:a.paid_total,
      trial_left:trialLeft,paid_left:paidLeft,remaining:trialLeft+paidLeft,
      used:counts.trial_used+counts.paid_used,reserved:counts.trial_reserved+counts.paid_reserved};
  }
  async function status(value){
    const uid=uidOf(value),c=await pool.connect();
    try{await ensure(c,uid);return await summaryWith(c,uid);}finally{c.release();}
  }
  async function reserve(value,source='edit'){
    const uid=uidOf(value),client=await pool.connect();
    try{
      await client.query('BEGIN');
      await ensure(client,uid);
      await client.query('SELECT uid FROM image_credit_accounts WHERE uid=$1 FOR UPDATE',[uid]);
      const balance=await summaryWith(client,uid);
      const type=balance.trial_left>0?'trial':balance.paid_left>0?'paid':null;
      if(!type){await client.query('COMMIT');return {ok:false,balance};}
      const id=crypto.randomUUID();
      await client.query(`INSERT INTO image_credit_usage(id,uid,credit_type,state,source,expires_at)
        VALUES($1,$2,$3,'reserved',$4,NOW()+INTERVAL '45 minutes')`,[id,uid,type,String(source).slice(0,40)]);
      await client.query('COMMIT');
      return {ok:true,id,credit_type:type};
    }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
  }
  async function finish(id,state){
    if(!/^[0-9a-f-]{36}$/i.test(String(id)))return;
    const target=state==='used'?'used':'released';
    await pool.query(`UPDATE image_credit_usage SET state=$2,finished_at=NOW()
      WHERE id=$1 AND state='reserved'`,[id,target]);
  }
  return {init,status,reserve,consume:id=>finish(id,'used'),release:id=>finish(id,'released')};
}
