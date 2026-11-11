// Inline-only Telegram administration. No password URL or shared admin links.
export function createPhotoAdminMenu(ops,tg,send){
 const pending=new Map(),expiry=15*60*1000;
 const keyboard=rows=>({inline_keyboard:rows});
 const message=(chat,text,rows)=>tg('sendMessage',{chat_id:chat,text,reply_markup:keyboard(rows),disable_web_page_preview:true});
 const menuRows=[
  [{text:'🎁 이용권 지급',callback_data:'pa:grantpass'},{text:'👥 회원 조회',callback_data:'pa:users'}],
  [{text:'🎫 이용권 관리',callback_data:'pa:lookup'}],
  [{text:'🧾 구매 신청',callback_data:'pa:orders'},{text:'🏷 이용권 상품',callback_data:'pa:products'}],
  [{text:'🛍 판매 설정',callback_data:'pa:settings'},{text:'🔐 관리자 권한',callback_data:'pa:admins'}]
 ];
 const back=[[{text:'↩ 관리자 메뉴',callback_data:'pa:home'}]];
 const fmt=n=>Number(n||0).toLocaleString('ko-KR');
 const uidOk=s=>/^\d{1,19}$/.test(String(s||''));
 const active=(actor,state)=>pending.set(String(actor),{...state,at:Date.now()});
 async function home(chat,actor){
  const data=await ops.overview(actor);
  await message(chat,'🔐 포토샵봇 관리자 전용\n\n회원 '+fmt(data.total)+'명 · 사용 정지 '+fmt(data.blocked)+'명\n완료된 편집 '+fmt(data.used)+'건 · 구매 승인 대기 '+fmt(data.pending)+'건\n\n아래에서 관리할 메뉴를 선택해 주세요.',menuRows);
 }
 async function search(chat,actor,q=''){
  const users=await ops.users(actor,q);
  if(!users.length){await message(chat,'검색된 회원이 없습니다.',back);return;}
  const rows=users.map(u=>[{text:(u.is_blocked?'⛔ ':'')+(u.display_name||u.username||u.uid).slice(0,23)+' · '+u.uid,callback_data:'pa:user:'+u.uid}]);
  rows.push(...back);
  await message(chat,'👥 회원 목록 (최대 12명)\nUID·이름·아이디 검색은 회원 조회 → 검색어 입력을 이용하세요.',rows);
 }
 async function userDetail(chat,actor,uid){
  const u=await ops.user(actor,uid);
  const text='👤 회원 관리\nUID: '+u.uid+'\n이름: '+(u.display_name||'—')+
  '\n아이디: '+(u.username?'@'+u.username:'—')+
  '\n무료 체험권: '+fmt(u.trial_left)+'회\n구매 이용권: '+fmt(u.paid_left)+'회'+
  '\n완료된 편집: '+fmt(u.used)+'회\n상태: '+(u.is_blocked?'⛔ 사용 정지':'정상');
  const rows=[
   [{text:'🎁 이용권 지급',callback_data:'pa:give:'+uid},{text:'이용권 증감',callback_data:'pa:editpass:'+uid}],
   [{text:'체험권 횟수 조정',callback_data:'pa:edittrial:'+uid}],
   [{text:u.is_blocked?'✅ 사용 정지 해제':'⛔ 사용 정지',callback_data:'pa:block:'+uid+':'+(u.is_blocked?'0':'1')}],
   [{text:'↩ 회원 목록',callback_data:'pa:users'},{text:'🏠 관리자 메뉴',callback_data:'pa:home'}]
  ];
  await message(chat,text,rows);
 }
 async function orders(chat,actor){
  const list=await ops.orders(actor);
  if(!list.length){await message(chat,'🧾 구매 승인 대기 건이 없습니다.',back);return;}
  for(const o of list){
   await message(chat,'🧾 이용권 구매 신청 #'+o.id+'\nUID: '+o.uid+
    '\n상품: '+o.package_name+
    '\n이용권: '+fmt(o.credits)+'매\n기준 가격: '+fmt(o.price_usdt)+' USDT'+
    '\n결제: '+fmt(o.payment_amount)+' '+o.payment_asset+
    '\n지갑: '+o.payment_address+
    '\n\n※ 블록체인 입금액·네트워크·거래내역을 실제 확인한 뒤 승인하세요.',[
      [{text:'✅ 입금 확인·승인',callback_data:'pa:confirm:approved:'+o.id},
       {text:'❌ 거절',callback_data:'pa:confirm:rejected:'+o.id}],...back]);
  }
 }
 async function products(chat,actor){
  const result=await ops.packages(actor);
  const rows=result.packages.map(p=>[{text:(p.active?'🟢 ':'⚪ ')+p.name+' / '+fmt(p.credits)+'매 / '+fmt(p.price_usdt)+' USDT',
   callback_data:'pa:package:'+p.id}]);
  rows.push(...back);
  await message(chat,'🏷 이용권 상품\n상품을 누르면 가격과 판매 여부를 수정할 수 있습니다.',rows);
 }
 async function saleSettings(chat,actor){
  const result=await ops.packages(actor);
  const st=result.settings||{};
  const short=v=>v?v.slice(0,7)+'…'+v.slice(-6):'미설정';
  await message(chat,'🛍 이용권 결제 설정\n판매 상태: '+(st.enabled?'🟢 판매 중':'⚪ 판매 중지')+
   '\nUSDT(TRC20): '+short(st.usdt_trc20_address)+
   '\nTRON(TRX): '+short(st.trx_address)+
   '\n환산율: 1 USDT = '+(st.trx_per_usdt||'미설정')+' TRX'+
   '\n\n⚠️ 본인 관리 지갑 주소를 설정하고 판매를 활성화해 주세요.\n입금은 자동 확인되지 않으며 승인 전에 블록체인 기록을 확인해야 합니다.',[
    [{text:st.enabled?'⏸ 판매 중지':'▶️ 판매 활성화',callback_data:'pa:sale:'+(st.enabled?'0':'1')}],
    [{text:'💵 USDT(TRC20) 주소',callback_data:'pa:paysetting:usdt_trc20_address'}],
    [{text:'🪙 TRON(TRX) 주소',callback_data:'pa:paysetting:trx_address'}],
    [{text:'📈 TRX 환산율',callback_data:'pa:paysetting:trx_per_usdt'}],
    [{text:'📝 구매 안내 문구',callback_data:'pa:paysetting:payment_instructions'}],
    ...back
   ]);
 }
 async function admins(chat,actor){
  const list=await ops.admins(actor);
  const lines=['🔐 포토샵봇 관리자 UID',''];
  const unique=new Set([...list.owners,...list.assigned.map(x=>x.uid)]);
  for(const uid of unique)lines.push((list.owners.includes(uid)?'👑 ':'✅ ')+uid);
  const rows=ops.isOwner(actor)?[
   [{text:'➕ 관리자 UID 등록',callback_data:'pa:grant'},{text:'➖ 관리자 UID 해제',callback_data:'pa:revoke'}],
   ...back]:back;
  await message(chat,lines.join('\n')+'\n\nUID 등록·해제는 최고 관리자만 가능합니다.',rows);
 }
 async function notify(uid,text){
  try{await send(uid,text);}catch(e){console.warn('photo admin user notify:',e.message);}
 }
 async function handle(update){
  const cb=update.callback_query,msg=update.message;
  const actor=String(cb?.from?.id||msg?.from?.id||'');
  const chat=cb?.message?.chat?.id||msg?.chat?.id;
  if(!actor||!chat)return false;
  const command=String(msg?.text||'').trim();
  const requested=Boolean(cb?.data?.startsWith('pa:')||
    ['/관리자','/admin','/관리자메뉴'].includes(command));
  const inProgress=pending.has(actor)&&msg?.chat?.type==='private'&&
    Boolean(command&&!command.startsWith('/'));
  if(!requested&&!inProgress)return false;
  if((cb?.message?.chat?.type||msg?.chat?.type)!=='private')return true;
  if(!await ops.isAdmin(actor)){
   if(cb)await tg('answerCallbackQuery',{callback_query_id:cb.id,text:'관리자 UID가 아닙니다.',show_alert:true});
   else await send(chat,'관리자 권한이 부여된 UID만 사용할 수 있습니다.');
   return true;
  }
  if(cb)await tg('answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>{});
  try{
   if(['/관리자','/admin','/관리자메뉴'].includes(command)){pending.delete(actor);await home(chat,actor);return true;}
   if(cb){
    const parts=cb.data.split(':'),action=parts[1];
    if(action==='home'){pending.delete(actor);await home(chat,actor);}
    else if(action==='grantpass'){
     active(actor,{mode:'giveuid'});await send(chat,'🎁 이용권 지급할 회원의 텔레그램 UID를 입력하세요.');
    }else if(action==='users'){
     active(actor,{mode:'search'});await send(chat,'👥 검색할 UID, 텔레그램 아이디 또는 이름을 입력하세요.\n전체 목록은 /관리자 메뉴에서 다시 확인할 수 있습니다.');await search(chat,actor);
    }else if(action==='lookup'){active(actor,{mode:'lookup'});await send(chat,'🎫 이용권을 관리할 회원의 UID를 입력하세요.');}
    else if(action==='user')await userDetail(chat,actor,parts[2]);
    else if(action==='give'){
     active(actor,{mode:'givecount',uid:parts[2]});await send(chat,'🎁 UID '+parts[2]+'에게 지급할 이용권 수량을 입력하세요.\n예: 10');
    }else if(action==='edittrial'||action==='editpass'){
     active(actor,{mode:'adjust',kind:action==='edittrial'?'trial':'pass',uid:parts[2]});
     await send(chat,'UID '+parts[2]+'의 '+(action==='edittrial'?'체험권':'구매 이용권')+' 증감 횟수를 입력하세요.\n예: 5 또는 -2');
    }else if(action==='block'){
     await ops.block(actor,parts[2],parts[3]==='1');await userDetail(chat,actor,parts[2]);
    }else if(action==='orders')await orders(chat,actor);
    else if(action==='confirm'){
     const decision=parts[2],id=parts[3];
     await message(chat,'신청 #'+id+'을 '+(decision==='approved'?'승인':'거절')+'하시겠습니까?\n승인 시 이용권이 즉시 지급되며 취소할 수 없습니다.',[
      [{text:'최종 '+(decision==='approved'?'승인':'거절'),callback_data:'pa:decide:'+decision+':'+id}],...back]);
    }else if(action==='decide'){
     const d=await ops.decide(actor,parts[3],parts[2]);
     await send(chat,'신청 #'+d.order_id+' 처리 완료. '+(d.decision==='approved'?d.passes+'회 지급':'거절'));
     await notify(d.uid,d.decision==='approved'
      ?'✅ 이용권 구매 승인\n신청 #'+d.order_id+' · '+d.passes+'회가 지급되었습니다.\n/잔여횟수 에서 확인하세요.'
      :'❌ 이용권 구매 신청 #'+d.order_id+'이 거절되었습니다.');
    }else if(action==='products')await products(chat,actor);
    else if(action==='package'){
     const result=await ops.packages(actor);const p=result.packages.find(x=>String(x.id)===parts[2]);
     if(!p)throw Error('상품을 찾을 수 없습니다.');
     await message(chat,'🏷 '+p.name+'\n이용권 '+p.credits+'회\n가격 '+fmt(p.price_krw)+'원\n판매 '+(p.active?'중':'중지'),[
       [{text:'✏️ 가격 변경',callback_data:'pa:price:'+p.id}],
       [{text:p.active?'판매 중지':'판매 허용',callback_data:'pa:togglepackage:'+p.id+':'+(p.active?'0':'1')}],
       [{text:'↩ 상품 목록',callback_data:'pa:products'}]
     ]);
    }else if(action==='price'){
     active(actor,{mode:'price',id:parts[2]});await send(chat,'새 판매 가격(USDT)을 숫자로 입력하세요.');
    }else if(action==='togglepackage'){
     const r=await ops.packages(actor),p=r.packages.find(x=>String(x.id)===parts[2]);
     if(!p)throw Error('상품을 찾을 수 없습니다.');
     await ops.changePackage(actor,parts[2],p.price_usdt,parts[3]==='1');await products(chat,actor);
    }else if(action==='settings')await saleSettings(chat,actor);
    else if(action==='sale'){await ops.settings(actor,parts[2]==='1');await saleSettings(chat,actor);}
    else if(action==='paysetting'){
     const field=parts[2];
     if(!['usdt_trc20_address','trx_address','trx_per_usdt','payment_instructions'].includes(field))throw Error('설정 항목이 잘못됐습니다.');
     active(actor,{mode:'paysetting',field});
     await send(chat,field==='usdt_trc20_address'
      ?'USDT (TRC20) 수취용 TRON 지갑 주소를 입력하세요. T로 시작하는 주소만 받습니다.'
      :field==='trx_address'
       ?'TRON(TRX) 수취용 지갑 주소를 입력하세요. T로 시작하는 주소만 받습니다.'
       :field==='trx_per_usdt'
        ?'1 USDT를 몇 TRX로 계산할지 입력하세요.\n예: 5.25\n※ 자동 시세가 아니므로 수시로 갱신해야 합니다.'
        :'구매자에게 보여줄 추가 입금 안내를 입력하세요.');
    }else if(action==='admins')await admins(chat,actor);
    else if(action==='grant'||action==='revoke'){
     if(!ops.isOwner(actor))throw Error('최고 관리자만 권한을 변경할 수 있습니다.');
     active(actor,{mode:action});await send(chat,'권한을 '+(action==='grant'?'부여':'해제')+'할 텔레그램 UID를 입력하세요.');
    }
    return true;
   }
   const state=pending.get(actor);
   if(!state)return false;
   if(Date.now()-state.at>expiry){pending.delete(actor);await send(chat,'입력 시간이 만료됐습니다. /관리자 로 다시 진행해 주세요.');return true;}
   pending.delete(actor);
   if(state.mode==='search')await search(chat,actor,command);
   else if(state.mode==='giveuid'){
    const u=await ops.user(actor,command);
    active(actor,{mode:'givecount',uid:u.uid});
    await send(chat,'🎁 '+u.uid+'에게 지급할 이용권 매수를 입력하세요.\n예: 10');
   }else if(state.mode==='givecount'){
    const num=Number(command);
    if(!Number.isSafeInteger(num)||num<=0||num>100000)throw Error('1~100000 사이의 지급 매수를 입력하세요.');
    const result=await ops.adjust(actor,state.uid,'pass',num);
    await send(chat,'✅ UID '+state.uid+'에게 이용권 '+num+'매 지급 완료.\n누적 구매·관리자 지급 이용권: '+result.after+'매');
    await notify(state.uid,'🎁 관리자 이용권 지급 안내\n편집 이용권 '+num+'매가 추가 지급되었습니다.\n/잔여횟수 로 확인하세요.');
    await userDetail(chat,actor,state.uid);
   }
   else if(state.mode==='lookup')await userDetail(chat,actor,command);
   else if(state.mode==='adjust'){
    const delta=Number(command);const result=await ops.adjust(actor,state.uid,state.kind,delta);
    await send(chat,'✅ 이용권 '+(delta>0?'+':'')+delta+'회 적용 · 총 지급 '+result.after+'회');await userDetail(chat,actor,state.uid);
   }else if(state.mode==='price'){
    const p=(await ops.packages(actor)).packages.find(x=>String(x.id)===state.id);
    if(!p)throw Error('상품을 찾을 수 없습니다.');
    await ops.changePackage(actor,state.id,Number(command),p.active);await products(chat,actor);
   }else if(state.mode==='paysetting'){await ops.paymentSettings(actor,state.field,command);await saleSettings(chat,actor);}
   else if(state.mode==='grant'){await ops.grant(actor,command);await admins(chat,actor);}
   else if(state.mode==='revoke'){await ops.revoke(actor,command);await admins(chat,actor);}
   return true;
  }catch(e){
   console.error('photo admin menu:',e.message);
   await send(chat,'관리자 처리 오류: '+String(e.message).slice(0,220));
   return true;
  }
 }
 return {handle,isAdmin:ops.isAdmin};
}
