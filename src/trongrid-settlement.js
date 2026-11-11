// Read-only TronGrid settlement: no wallet keys, signing or transfers.
const WALLET=String(process.env.TRONGRID_WALLET_ADDRESS||'TDTw6GaL2GwjPY8JgY8fsk6hip5UAwcWDX');
const USDT_CONTRACT='TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const API='https://api.trongrid.io';
const key=()=>String(process.env.TRONGRID_API_KEY||'').trim();
const waitMs=Number(process.env.TRONGRID_POLL_MS)||60000;
const u6=x=>{const v=String(x);if(!/^\d+(?:\.\d{1,6})?$/.test(v))throw Error('Invalid payment quantity');const [a,b='']=v.split('.');return BigInt(a)*1000000n+BigInt((b+'000000').slice(0,6));};
async function fetchPage(path,query){
 const url=new URL(API+path);for(const [k,v] of Object.entries(query))url.searchParams.set(k,String(v));
 const r=await fetch(url,{headers:{'TRON-PRO-API-KEY':key()},signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('TronGrid HTTP '+r.status);
 const result=await r.json();
 if(result.success===false||!Array.isArray(result.data))throw Error('Unexpected TronGrid response');
 return result;
}
async function fetchIncoming(asset,earliest){
 const path='/v1/accounts/'+WALLET+'/transactions'+(asset==='USDT'?'/trc20':'');
 const query={only_confirmed:'true',only_to:'true',min_timestamp:String(earliest),limit:'200'};
 if(asset==='USDT')query.contract_address=USDT_CONTRACT;
 const incoming=[],seen=new Set();
 for(let p=0;p<10;p++){
  const result=await fetchPage(path,query);
  for(const t of result.data){
   if(asset==='USDT'){
    if(t.to!==WALLET||t.token_info?.address!==USDT_CONTRACT||t.type!=='Transfer')continue;
    const value=String(t.value||'');
    if(!/^\d+$/.test(value))continue;
    const txid=String(t.transaction_id||'');
    if(!/^[a-fA-F0-9]{64}$/.test(txid))continue;
    incoming.push({txid,amount:BigInt(value),ts:Number(t.block_timestamp)});
   }else{
    if(!Array.isArray(t.raw_data?.contract)||t.raw_data.contract.length!==1)continue;
    const c=t.raw_data.contract[0];
    if(c.type!=='TransferContract'||t.ret?.[0]?.contractRet!=='SUCCESS')continue;
    const amount=String(c.parameter?.value?.amount??'');
    const txid=String(t.txID||'');
    if(!/^\d+$/.test(amount)||!/^[a-fA-F0-9]{64}$/.test(txid))continue;
    // The query's only_to filter is supplemented by a strict owner-address
    // check in hex (the TRON address is converted without a third-party lib).
    if(c.parameter?.value?.to_address?.toLowerCase()!==addressHex(WALLET))continue;
    incoming.push({txid,amount:BigInt(amount),ts:Number(t.block_timestamp)});
   }
  }
  const next=result.meta?.fingerprint;
  if(!next||seen.has(next))break;seen.add(next);query.fingerprint=next;
 }
 return incoming;
}
function addressHex(addr){
 const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
 let n=0n;for(const c of addr){const i=alphabet.indexOf(c);if(i<0)throw Error('Bad Tron address');n=n*58n+BigInt(i);}
 let h=n.toString(16);if(h.length%2)h='0'+h;
 const chars=addr.match(/^1+/)?.[0]?.length||0;h='00'.repeat(chars)+h;
 const bytes=Buffer.from(h,'hex');
 if(bytes.length!==25||bytes[0]!==0x41)throw Error('Invalid Tron address format');
 return bytes.subarray(0,21).toString('hex');
}
export function createTronGridSettlement(pool,notify){
 let running=false,healthy=false;
 async function init(){
  await pool.query(`CREATE TABLE IF NOT EXISTS image_payment_transactions(
   txid TEXT PRIMARY KEY,order_id BIGINT NOT NULL UNIQUE REFERENCES image_shop_orders(id),
   asset TEXT NOT NULL,amount NUMERIC(22,6) NOT NULL,
   confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
   ALTER TABLE image_shop_orders ADD COLUMN IF NOT EXISTS payment_txid TEXT;
   ALTER TABLE image_shop_orders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
   ALTER TABLE image_shop_orders ADD COLUMN IF NOT EXISTS auto_match BOOLEAN NOT NULL DEFAULT FALSE;
   CREATE UNIQUE INDEX IF NOT EXISTS image_active_payment_amount_uniq
    ON image_shop_orders(payment_asset,payment_amount,payment_address)
    WHERE state='pending' AND auto_match=TRUE;`);
  await pool.query('UPDATE image_shop_settings SET usdt_trc20_address=$1,trx_address=$1 WHERE singleton=TRUE',[WALLET]);
 }
 async function probe(){
  if(!key())return false;
  try{
   const result=await fetchPage('/v1/accounts/'+WALLET+'/transactions/trc20',{
    only_confirmed:'true',contract_address:USDT_CONTRACT,limit:'1'});
   healthy=Array.isArray(result.data);
   if(healthy)console.log('TronGrid API authenticated and responding for monitored wallet');
   return healthy;
  }catch(e){healthy=false;console.error('TronGrid API health check failed:',e.message);return false;}
 }
 async function check(){
  if(!key()||running)return;
  running=true;
  try{
   // Transactions only for recent, uniquely identified orders. No historical
   // deposits are ever credited; previously created manual orders opt out.
   const orders=(await pool.query(`SELECT id,uid::text,credits,payment_asset,payment_amount,
    extract(epoch from created_at)*1000 AS created_ms FROM image_shop_orders
    WHERE state='pending' AND auto_match=TRUE AND payment_address=$1
    AND created_at>NOW()-INTERVAL '7 days'
    AND (expires_at IS NULL OR expires_at>NOW())
    ORDER BY created_at DESC LIMIT 300`,[WALLET])).rows;
   if(!orders.length)return;
   const earliest=Math.max(Date.now()-7*86400000,Math.min(...orders.map(o=>Number(o.created_ms)))-120000);
   const transfers={};
   for(const asset of ['USDT','TRX'])if(orders.some(o=>o.payment_asset===asset))
    transfers[asset]=await fetchIncoming(asset,earliest);
   for(const o of orders){
    const tx=(transfers[o.payment_asset]||[]).find(t=>t.amount===u6(o.payment_amount)&&t.ts>=Number(o.created_ms)-30000);
    if(!tx)continue;
    const client=await pool.connect();let approved=false;
    try{
     await client.query('BEGIN');
     const row=(await client.query('SELECT * FROM image_shop_orders WHERE id=$1 FOR UPDATE',[o.id])).rows[0];
     if(row?.state!=='pending'||!row.auto_match||row.payment_address!==WALLET){await client.query('ROLLBACK');continue;}
     if(u6(row.payment_amount)!==tx.amount){await client.query('ROLLBACK');continue;}
     const inserted=await client.query(`INSERT INTO image_payment_transactions(txid,order_id,asset,amount)
       VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING txid`,[tx.txid,o.id,o.payment_asset,o.payment_amount]);
     if(!inserted.rowCount){await client.query('ROLLBACK');continue;}
     await client.query('SELECT uid FROM image_credit_accounts WHERE uid=$1 FOR UPDATE',[row.uid]);
     await client.query('UPDATE image_credit_accounts SET paid_total=paid_total+$2,updated_at=NOW() WHERE uid=$1',[row.uid,row.credits]);
     await client.query(`UPDATE image_shop_orders SET state='approved',decided_at=NOW(),
       payment_txid=$2,decision_note='TronGrid confirmed auto deposit' WHERE id=$1`,[o.id,tx.txid]);
     await client.query('INSERT INTO image_admin_audit(action,uid,details) VALUES($1,$2,$3)',
      ['trongrid_auto_approved',row.uid,JSON.stringify({order_id:o.id,txid:tx.txid,asset:o.payment_asset,amount:o.payment_amount,credits:row.credits})]);
     await client.query('COMMIT');approved=true;
    }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
    if(approved)await notify(o.uid,'✅ 입금 자동 확인 완료\n이용권 '+o.credits+'매가 지급됐어.\n주문 #'+o.id+'\n/잔여횟수 에서 확인해 줘.').catch(console.error);
   }
  }catch(e){console.error('TronGrid deposit scan:',e.message)}finally{running=false;}
 }
 function start(){
  if(!key()){console.log('TronGrid automatic credit disabled until TRONGRID_API_KEY is set');return;}
  console.log('TronGrid deposit watcher active for '+WALLET);
  probe().then(ok=>{if(ok)check().catch(console.error)}).catch(console.error);
  setInterval(async()=>{
   if(!healthy){if(!await probe())return;}
   await check();
  },Math.max(30000,waitMs)).unref();
 }
 return {init,start,check,isReady:()=>healthy};
}
