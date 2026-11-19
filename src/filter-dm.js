// Telegram private-chat UI for delegated group word filtering.
// Every group-specific operation checks Telegram administrator membership live.
// This feature never sends a message to groups or performs moderation itself.
const durations=[3600,43200,86400,259200,604800,0];
const durationLabels=new Map([[3600,'1시간'],[43200,'12시간'],[86400,'24시간'],[259200,'3일'],[604800,'7일'],[0,'무기한']]);
const menu=(rows)=>({inline_keyboard:rows});
const btn=(label,data)=>({text:label,callback_data:data});
const gid=value=>/^-100[0-9]{6,16}$/.test(String(value||''))?String(value):null;

export function createFilterPrivateMenu({tg,sql,normalizeFilterWords}){
 async function isAdmin(chatId,userId){
  const registered=await sql('SELECT 1 FROM groups WHERE chat_id=$1 AND is_connected=TRUE',[chatId]);
  if(!registered.length)return false;
  try{
   const m=await tg('getChatMember',{chat_id:chatId,user_id:userId});
   return m.status==='administrator'||m.status==='creator';
  }catch{return false}
 }
 async function requireAdmin(chatId,userId){
  if(!chatId||!(await isAdmin(chatId,userId)))throw new Error('현재 이 그룹의 텔레그램 관리자가 아니거나 봇이 연결되어 있지 않습니다.');
 }
 async function setting(chatId){
  const rows=await sql('SELECT enabled,words,mute_seconds FROM group_word_filters WHERE chat_id=$1',[chatId]);
  return rows[0]||{enabled:false,words:[],mute_seconds:86400};
 }
 async function display(chatId,userId,chat,msgId,text,keyboard){
  // This always uses the private conversation, never the original group.
  const payload={chat_id:chat,text,reply_markup:menu(keyboard)};
  if(msgId){
   try{await tg('editMessageText',{...payload,message_id:msgId});return}
   catch(e){if(/message is not modified/i.test(e.message))return}
  }
  await tg('sendMessage',payload);
 }
 async function listGroups(userId,chat,msgId,page=0){
  const all=await sql('SELECT chat_id::text,title FROM groups WHERE is_connected=TRUE ORDER BY title LIMIT 150');
  const checks=await Promise.all(all.map(async(g)=>{
   const ok=await isAdmin(g.chat_id,userId);
   return ok?g:null;
  }));
  const matches=checks.filter(Boolean);
  if(!matches.length){
   await display(null,userId,chat,msgId,'🛡 금칙어 필터 관리\n\n현재 관리자로 확인되는 연결 그룹이 없습니다. 봇이 그룹에 추가되어 있고 본인이 해당 그룹의 관리자인지 확인해 주세요.',[[btn('🔄 그룹 다시 확인','wf|list|0')]]);
   return;
  }
  const last=Math.max(0,Math.ceil(matches.length/8)-1),p=Math.min(Math.max(page,0),last);
  const buttons=matches.slice(p*8,(p+1)*8).map(g=>[btn('🛡 '+g.title.slice(0,35),'wf|group|'+g.chat_id)]);
  const controls=[];
  if(p>0)controls.push(btn('◀ 이전','wf|list|'+(p-1)));
  if(p<last)controls.push(btn('다음 ▶','wf|list|'+(p+1)));
  if(controls.length)buttons.push(controls);
  buttons.push([btn('🔄 새로고침','wf|list|'+p)]);
  await display(null,userId,chat,msgId,'🛡 그룹별 금칙어 필터\n\n아래에서 관리할 그룹을 선택하세요. 비밀번호나 회원가입은 필요 없습니다.\n\n관리 중인 그룹 '+matches.length+'개 · '+(p+1)+'/'+(last+1)+'페이지',buttons);
 }
 async function groupMenu(chatId,userId,chat,msgId){
  await requireAdmin(chatId,userId);
  const [info]=await sql('SELECT title FROM groups WHERE chat_id=$1',[chatId]);
  const cfg=await setting(chatId);
  const words=Array.isArray(cfg.words)?cfg.words:[];
  const line=words.length?words.slice(0,16).map((w,i)=>(i+1)+'. '+w).join('\n')+(words.length>16?'\n…외 '+(words.length-16)+'개':''):'등록된 금칙어 없음';
  const message='🛡 '+info.title+'\n\n필터: '+(cfg.enabled?'✅ 작동 중':'⏸ 사용 안 함')+'\n금칙어: '+words.length+'개\n채팅정지: '+durationLabels.get(cfg.mute_seconds)+'\n\n'+line+'\n\n금칙어 감지 시 채팅정지만 적용합니다. 추방·삭제·Mute 안내 메시지는 보내지 않습니다.';
  const keyboard=[
   [btn('➕ 금칙어 추가','wf|add|'+chatId),btn('➖ 금칙어 삭제','wf|del|'+chatId+'|0')],
   [btn('⏱ 정지 시간','wf|time|'+chatId)],
   [btn(cfg.enabled?'⏸ 필터 끄기':'✅ 필터 켜기','wf|toggle|'+chatId)],
   [btn('◀ 내 그룹 목록','wf|list|0')]
  ];
  await display(chatId,userId,chat,msgId,message,keyboard);
 }
 async function deleteList(chatId,userId,chat,msgId,page=0){
  await requireAdmin(chatId,userId);
  const cfg=await setting(chatId);
  const words=Array.isArray(cfg.words)?cfg.words:[];
  if(!words.length){await groupMenu(chatId,userId,chat,msgId);return}
  const last=Math.max(0,Math.ceil(words.length/8)-1),p=Math.min(Math.max(page,0),last);
  const keyboard=words.slice(p*8,(p+1)*8).map((w,i)=>[btn('✖ '+w.slice(0,42),'wf|remove|'+chatId+'|'+(p*8+i))]);
  const nav=[];
  if(p>0)nav.push(btn('◀ 이전','wf|del|'+chatId+'|'+(p-1)));
  if(p<last)nav.push(btn('다음 ▶','wf|del|'+chatId+'|'+(p+1)));
  if(nav.length)keyboard.push(nav);
  keyboard.push([btn('◀ 금칙어 설정','wf|group|'+chatId)]);
  await display(chatId,userId,chat,msgId,'삭제할 금칙어를 선택하세요.\n\n삭제 후 해당 단어는 더 이상 감지하지 않습니다.',keyboard);
 }
 async function durationMenu(chatId,userId,chat,msgId){
  await requireAdmin(chatId,userId);
  const keys=[[3600,43200],[86400,259200],[604800,0]].map(pair=>pair.map(s=>btn(durationLabels.get(s),'wf|duration|'+chatId+'|'+s)));
  keys.push([btn('◀ 금칙어 설정','wf|group|'+chatId)]);
  await display(chatId,userId,chat,msgId,'⏱ 금칙어 감지 시 적용할 채팅정지 시간을 선택하세요.\n\n정지된 회원은 그룹에서 추방되지 않습니다.',keys);
 }
 async function saveWords(chatId,words){
  await sql(`INSERT INTO group_word_filters(chat_id,words,updated_at) VALUES($1,$2::jsonb,NOW())
  ON CONFLICT(chat_id) DO UPDATE SET words=EXCLUDED.words,updated_at=NOW()`,[chatId,JSON.stringify(words)]);
 }
 async function pending(userId){
  const rows=await sql("SELECT chat_id::text,action FROM filter_dm_pending WHERE user_id=$1 AND created_at>NOW()-INTERVAL '10 minutes'",[userId]);
  return rows[0]||null;
 }
 async function setPending(userId,chatId,action){
  await sql(`INSERT INTO filter_dm_pending(user_id,chat_id,action,created_at)
  VALUES($1,$2,$3,NOW()) ON CONFLICT(user_id) DO UPDATE SET chat_id=EXCLUDED.chat_id,action=EXCLUDED.action,created_at=NOW()`,[userId,chatId,action]);
 }
 async function clearPending(userId){await sql('DELETE FROM filter_dm_pending WHERE user_id=$1',[userId])}
 async function handleMessage(msg){
  if(msg?.chat?.type!=='private'||!msg.from?.id||msg.from.is_bot)return false;
  const raw=String(msg.text||'').trim(),userId=String(msg.from.id),chat=msg.chat.id;
  if(/^\/(start|filter|filters|menu)(?:@\w+)?(?:\s|$)/i.test(raw)){
   await clearPending(userId);
   await listGroups(userId,chat,null,0);
   return true;
  }
  if(/^\/cancel(?:@\w+)?$/i.test(raw)){
   await clearPending(userId);
   await tg('sendMessage',{chat_id:chat,text:'입력을 취소했습니다. /start 로 그룹을 다시 선택할 수 있습니다.'});
   return true;
  }
  const input=await pending(userId);
  if(!input)return false;
  await clearPending(userId);
  try{
   await requireAdmin(input.chat_id,userId);
   if(input.action!=='add')return false;
   if(raw.startsWith('/'))throw new Error('금칙어를 줄 단위로 입력해 주세요.');
   const additions=normalizeFilterWords(raw.split(/\r?\n/));
   if(!additions.length)throw new Error('추가할 단어를 입력해 주세요.');
   const current=await setting(input.chat_id);
   const words=normalizeFilterWords([...(Array.isArray(current.words)?current.words:[]),...additions]);
   await saveWords(input.chat_id,words);
   await tg('sendMessage',{chat_id:chat,text:'✅ 금칙어 '+additions.length+'개 입력 완료. 현재 '+words.length+'개 등록됨.\n적용 상태: '+(current.enabled?'작동 중':'사용 안 함 (설정 메뉴에서 활성화)')});
   await groupMenu(input.chat_id,userId,chat,null);
  }catch(e){
   await tg('sendMessage',{chat_id:chat,text:'설정 실패: '+String(e.message).slice(0,180)+'\n/start 를 눌러 다시 설정해 주세요.'});
  }
  return true;
 }
 async function handleCallback(cb){
  const chat=cb?.message?.chat?.id,userId=cb?.from?.id,msgId=cb?.message?.message_id;
  if(!userId||!chat||cb.message.chat.type!=='private'||typeof cb.data!=='string'||!cb.data.startsWith('wf|'))return false;
  // Answer every callback quickly (only in private chat; no group messages).
  await tg('answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>{});
  const [prefix,act,id,arg]=cb.data.split('|');
  if(prefix!=='wf')return true;
  try{
   await clearPending(String(userId));
   if(act==='list'){await listGroups(userId,chat,msgId,Math.max(0,Math.min(Number(id)||0,25)));return true}
   const groupId=gid(id);
   await requireAdmin(groupId,userId);
   if(act==='group'){await groupMenu(groupId,userId,chat,msgId);return true}
   if(act==='add'){
    await setPending(userId,groupId,'add');
    await display(groupId,userId,chat,msgId,'➕ 추가할 금칙어를 이 개인 채팅에 입력해 주세요.\n\n여러 개를 한 번에 추가하려면 한 줄에 하나씩 입력하세요.\n\n10분 안에 입력해 주세요. 취소: /cancel',[[btn('◀ 취소','wf|group|'+groupId)]]);
    return true;
   }
   if(act==='del'){await deleteList(groupId,userId,chat,msgId,Math.max(0,Math.min(Number(arg)||0,20)));return true}
   if(act==='remove'){
    const index=Number(arg);
    const cfg=await setting(groupId),words=Array.isArray(cfg.words)?cfg.words:[];
    if(!Number.isSafeInteger(index)||index<0||index>=words.length)throw new Error('목록이 변경됐습니다. 다시 선택해 주세요.');
    words.splice(index,1);
    await saveWords(groupId,words);
    // Disable automatically when the last word is removed.
    if(words.length===0)await sql('UPDATE group_word_filters SET enabled=FALSE WHERE chat_id=$1',[groupId]);
    await groupMenu(groupId,userId,chat,msgId);return true;
   }
   if(act==='time'){await durationMenu(groupId,userId,chat,msgId);return true}
   if(act==='duration'){
    const duration=Number(arg);
    if(!durationLabels.has(duration))throw new Error('지원하지 않는 정지 시간입니다.');
    await sql(`INSERT INTO group_word_filters(chat_id,mute_seconds,updated_at) VALUES($1,$2,NOW())
     ON CONFLICT(chat_id) DO UPDATE SET mute_seconds=EXCLUDED.mute_seconds,updated_at=NOW()`,[groupId,duration]);
    await groupMenu(groupId,userId,chat,msgId);return true;
   }
   if(act==='toggle'){
    const cfg=await setting(groupId);
    if(!cfg.enabled){
     if(!Array.isArray(cfg.words)||!cfg.words.length)throw new Error('금칙어를 먼저 등록해 주세요.');
     const me=await tg('getMe');
     const bot=await tg('getChatMember',{chat_id:groupId,user_id:me.id});
     if(bot.status!=='administrator'||!bot.can_restrict_members)throw new Error('봇에 회원 차단·제한 관리자 권한이 필요합니다.');
     const info=await tg('getChat',{chat_id:groupId});
     if(info.type!=='supergroup')throw new Error('자동 채팅정지는 슈퍼그룹에서만 지원합니다.');
    }
    await sql(`INSERT INTO group_word_filters(chat_id,enabled,updated_at) VALUES($1,$2,NOW())
      ON CONFLICT(chat_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=NOW()`,[groupId,!cfg.enabled]);
    await groupMenu(groupId,userId,chat,msgId);return true;
   }
   await listGroups(userId,chat,msgId,0);
  }catch(e){
   await tg('sendMessage',{chat_id:chat,text:'설정을 처리하지 못했습니다: '+String(e.message).slice(0,180)+'\n/start 로 그룹을 다시 선택해 주세요.'});
  }
  return true;
 }
 return {handleMessage,handleCallback};
}
