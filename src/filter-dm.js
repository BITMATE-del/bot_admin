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
 async function verifyCandidates(rows,userId){
  const matches=[];
  // Bounded Telegram requests: never fire 100+ getChatMember calls at once.
  for(let i=0;i<rows.length;i+=6){
   const batch=await Promise.all(rows.slice(i,i+6).map(async g=>(await isAdmin(g.chat_id,userId))?g:null));
   matches.push(...batch.filter(Boolean));
  }
  return matches;
 }
 async function showMatches(userId,chat,msgId,matches,page=0,heading='내가 관리하는 그룹'){
  const last=Math.max(0,Math.ceil(matches.length/8)-1),p=Math.min(Math.max(page,0),last);
  const buttons=matches.slice(p*8,(p+1)*8).map(g=>[btn('🛡 '+g.title.slice(0,35),'wf|group|'+g.chat_id)]);
  if(matches.length>8){
   const nav=[];
   if(p>0)nav.push(btn('◀ 이전','wf|list|'+(p-1)));
   if(p<last)nav.push(btn('다음 ▶','wf|list|'+(p+1)));
   if(nav.length)buttons.push(nav);
  }
  buttons.push([btn('🔎 그룹명으로 검색','wf|search')]);
  buttons.push([btn('🔄 내 그룹 다시 확인','wf|list|0')]);
  await display(null,userId,chat,msgId,'🛡 '+heading+'\n\n'+(matches.length?'관리자 권한 확인된 그룹 '+matches.length+'개':'최근 확인된 그룹이 없습니다.')+'\n\n목록에 내 그룹이 없다면 아래 그룹 검색을 눌러 이름 일부로 찾을 수 있습니다.\n비밀번호나 회원가입은 필요 없습니다.',buttons);
 }
 async function listGroups(userId,chat,msgId,page=0){
  // Use bot-observed membership as a shortcut. A group administrator who never
  // posted in the group can always find their group with the name search.
  const observed=await sql(`SELECT g.chat_id::text,g.title FROM groups g
   JOIN members m ON m.chat_id=g.chat_id AND m.user_id=$1
   WHERE g.is_connected=TRUE ORDER BY m.last_seen DESC LIMIT 48`,[userId]);
  const matches=await verifyCandidates(observed,userId);
  await showMatches(userId,chat,msgId,matches,page);
 }
 async function searchGroups(userId,chat,term){
  const q=String(term||'').trim().slice(0,70);
  if(q.length<2)throw new Error('그룹 이름을 두 글자 이상 입력해 주세요.');
  const candidates=await sql(`SELECT chat_id::text,title FROM groups
    WHERE is_connected=TRUE AND POSITION(LOWER($1) IN LOWER(title))>0
    ORDER BY title LIMIT 30`,[q]);
  const matches=await verifyCandidates(candidates,userId);
  await showMatches(userId,chat,null,matches,0,'검색 결과: '+q);
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
   [btn('📋 이 설정을 내 모든 그룹에 적용','wf|bulk|'+chatId)],
   [btn('◀ 내 그룹 목록','wf|list|0')]
  ];
  await display(chatId,userId,chat,msgId,message,keyboard);
 }

 // Bulk changes use a two-step private-chat preview/confirmation workflow.
 // Only groups for which the Telegram user is currently administrator qualify.
 async function beginBulkPreview(sourceId,userId,chat,msgId){
  await requireAdmin(sourceId,userId);
  const cfg=await setting(sourceId);
  const words=normalizeFilterWords(Array.isArray(cfg.words)?cfg.words:[]);
  if(!words.length)throw new Error('기준 그룹에 금칙어를 먼저 등록해 주세요.');
  const [g]=await sql('SELECT title FROM groups WHERE chat_id=$1',[sourceId]);
  const active=await sql(`SELECT id::text FROM filter_bulk_jobs WHERE user_id=$1
    AND status IN ('checking','ready','applying') AND created_at>NOW()-INTERVAL '60 minutes'
    ORDER BY id DESC LIMIT 1`,[userId]);
  if(active.length)throw new Error('진행 중인 전체적용 작업이 있습니다. 작업이 끝난 뒤 다시 시도해 주세요.');
  const snapshot={enabled:!!cfg.enabled,words,mute_seconds:Number(cfg.mute_seconds)};
  const rows=await sql(`INSERT INTO filter_bulk_jobs(user_id,private_chat_id,source_chat_id,source_title,settings,status)
    VALUES($1,$2,$3,$4,$5::jsonb,'checking') RETURNING id::text`,
    [userId,chat,sourceId,String(g?.title||'선택 그룹').slice(0,140),JSON.stringify(snapshot)]);
  await display(sourceId,userId,chat,msgId,
   '📋 전체적용 대상 확인 중\n\n기준 그룹: '+String(g?.title||sourceId)+'\n금칙어 '+words.length+'개 · 정지 시간 '+(durationLabels.get(snapshot.mute_seconds)||'24시간')+
   '\n상태: '+(snapshot.enabled?'활성화':'비활성화')+
   '\n\n연결된 그룹 중 본인이 실제 관리자인 방만 확인합니다. 확인이 끝나면 정확한 적용 건수와 최종 확인 버튼을 개인 채팅으로 보내드립니다.\n\n그룹 채팅에는 아무 메시지도 보내지 않습니다.',
   [[btn('◀ 설정으로 돌아가기','wf|group|'+sourceId)]]);
  return rows[0].id;
 }
 async function confirmBulk(jobId,userId,chat){
  if(!/^\d{1,19}$/.test(String(jobId)))throw new Error('잘못된 전체적용 작업 번호입니다.');
  const rows=await sql(`UPDATE filter_bulk_jobs SET status='applying',updated_at=NOW()
    WHERE id=$1 AND user_id=$2 AND private_chat_id=$3 AND status='ready'
      AND created_at>NOW()-INTERVAL '20 minutes'
    RETURNING id::text,source_chat_id::text,eligible_count`,[jobId,userId,chat]);
  if(!rows.length)throw new Error('적용 대기 중인 작업이 없거나 확인 시간이 만료됐습니다.');
  await tg('sendMessage',{chat_id:chat,text:'✅ 전체적용 요청을 접수했습니다. '+rows[0].eligible_count+'개 그룹을 대상으로 관리자 권한을 다시 확인하며 적용합니다. 완료 결과는 이 개인 채팅으로 알려드립니다.'});
 }
 async function cancelBulk(jobId,userId,chat){
  if(!/^\d{1,19}$/.test(String(jobId)))throw new Error('잘못된 작업 번호입니다.');
  await sql(`UPDATE filter_bulk_jobs SET status='cancelled',updated_at=NOW()
    WHERE id=$1 AND user_id=$2 AND private_chat_id=$3 AND status IN ('checking','ready')`,
    [jobId,userId,chat]);
  await tg('sendMessage',{chat_id:chat,text:'전체적용을 취소했습니다. 다른 그룹의 설정은 변경되지 않았습니다.'});
 }
 async function claimBulkJob(){
  const rows=await sql(`UPDATE filter_bulk_jobs SET
    status=CASE WHEN status='checking' THEN 'checking_running' ELSE 'applying_running' END,
    updated_at=NOW()
    WHERE id=(
      SELECT id FROM filter_bulk_jobs WHERE
       status IN ('checking','applying')
       OR (status IN ('checking_running','applying_running') AND updated_at<NOW()-INTERVAL '3 minutes')
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING id::text,user_id::text,private_chat_id::text,source_chat_id::text,
      source_title,settings,targets,status,eligible_count,applied_count,skipped_count`);
  return rows[0]||null;
 }
 async function checkBulkJob(job){
  const all=await sql('SELECT chat_id::text,title FROM groups WHERE is_connected=TRUE ORDER BY title LIMIT 2000');
  const allowed=[];
  // Limit concurrent Telegram checks to reduce 429s and never trust DB membership
  // as an authority for modifying another group's configuration.
  for(let i=0;i<all.length;i+=4){
   const states=await Promise.all(all.slice(i,i+4).map(async g=>{
    try{return await isAdmin(g.chat_id,job.user_id)?g:null}catch{return null}
   }));
   allowed.push(...states.filter(Boolean));
   await sql("UPDATE filter_bulk_jobs SET updated_at=NOW() WHERE id=$1 AND status='checking_running'",[job.id]);
  }
  const current=await sql("SELECT status FROM filter_bulk_jobs WHERE id=$1",[job.id]);
  if(current[0]?.status!=='checking_running')return;
  if(!allowed.length){
   await sql("UPDATE filter_bulk_jobs SET status='failed',error_text='관리자로 확인된 그룹이 없습니다',updated_at=NOW() WHERE id=$1 AND status='checking_running'",[job.id]);
   await tg('sendMessage',{chat_id:job.private_chat_id,text:'전체적용 대상 확인 결과: 관리자로 확인되는 그룹이 없습니다. 설정은 변경되지 않았습니다.'});
   return;
  }
  await sql(`UPDATE filter_bulk_jobs SET status='ready',targets=$2::jsonb,eligible_count=$3,updated_at=NOW()
    WHERE id=$1 AND status='checking_running'`,[job.id,JSON.stringify(allowed),allowed.length]);
  const cfg=job.settings;
  const titles=allowed.slice(0,12).map(g=>'• '+g.title.slice(0,55)).join('\n');
  await tg('sendMessage',{chat_id:job.private_chat_id,
   text:'📋 금칙어 전체적용 최종 확인\n\n기준 그룹: '+job.source_title+
    '\n금칙어: '+cfg.words.length+'개\n정지 시간: '+(durationLabels.get(cfg.mute_seconds)||cfg.mute_seconds+'초')+
    '\n적용 상태: '+(cfg.enabled?'✅ 켜짐':'⏸ 꺼짐')+
    '\n\n본인이 관리자로 확인된 그룹: '+allowed.length+'개\n'+titles+
    (allowed.length>12?'\n…외 '+(allowed.length-12)+'개':'')+
    '\n\n⚠️ 확인하면 해당 그룹들의 기존 금칙어 목록·정지 시간·켜짐/꺼짐 상태가 모두 교체됩니다.\n권한이 변경되었거나 봇 제한 권한이 없는 그룹은 자동으로 건너뜁니다.\n20분 안에 확인해 주세요.',
   reply_markup:menu([[btn('✅ '+allowed.length+'개 그룹 전체적용','wf|bulkconfirm|'+job.id)],
                       [btn('❌ 취소','wf|bulkcancel|'+job.id)]])});
 }
 async function applyBulkJob(job){
  const cfg=job.settings,targets=Array.isArray(job.targets)?job.targets:[];
  if(!cfg||!Array.isArray(cfg.words)||!targets.length)throw new Error('전체적용 대상과 설정값이 올바르지 않습니다.');
  const words=normalizeFilterWords(cfg.words);
  if(!words.length||!durationLabels.has(Number(cfg.mute_seconds)))throw new Error('전체적용 설정값이 유효하지 않습니다.');
  const me=cfg.enabled?await tg('getMe'):null;
  let applied=Number(job.applied_count||0),skipped=Number(job.skipped_count||0);
  for(let i=applied+skipped;i<targets.length;i++){
   const target=targets[i];
   const current=await sql('SELECT status FROM filter_bulk_jobs WHERE id=$1',[job.id]);
   if(current[0]?.status!=='applying_running')return;
   let permitted=false;
   try{
    if(await isAdmin(target.chat_id,job.user_id)){
     if(cfg.enabled){
      const bot=await tg('getChatMember',{chat_id:target.chat_id,user_id:me.id});
      const details=await tg('getChat',{chat_id:target.chat_id});
      permitted=bot.status==='administrator'&&!!bot.can_restrict_members&&details.type==='supergroup';
     }else permitted=true;
    }
    if(permitted){
     await sql(`INSERT INTO group_word_filters(chat_id,enabled,words,mute_seconds,updated_at)
      VALUES($1,$2,$3::jsonb,$4,NOW())
      ON CONFLICT(chat_id) DO UPDATE SET
       enabled=EXCLUDED.enabled,words=EXCLUDED.words,mute_seconds=EXCLUDED.mute_seconds,updated_at=NOW()`,
      [target.chat_id,!!cfg.enabled,JSON.stringify(words),cfg.mute_seconds]);
     applied++;
    }else skipped++;
   }catch(e){skipped++;console.warn('bulk word filter skipped group',target.chat_id,e.message)}
   await sql(`UPDATE filter_bulk_jobs SET applied_count=$2,skipped_count=$3,updated_at=NOW()
    WHERE id=$1 AND status='applying_running'`,[job.id,applied,skipped]);
  }
  await sql("UPDATE filter_bulk_jobs SET status='done',updated_at=NOW() WHERE id=$1 AND status='applying_running'",[job.id]);
  await tg('sendMessage',{chat_id:job.private_chat_id,text:
   '✅ 금칙어 전체적용 완료\n\n기준 그룹: '+job.source_title+
   '\n정상 적용: '+applied+'개 그룹\n건너뜀: '+skipped+'개 그룹'+
   '\n\n금칙어 '+words.length+'개 · '+(durationLabels.get(cfg.mute_seconds)||'')+' · '+(cfg.enabled?'필터 켜짐':'필터 꺼짐')+
   '\n\n추방·메시지 삭제·Mute 안내 메시지는 발생하지 않습니다.\n/start 에서 개별 그룹 설정을 확인할 수 있습니다.'});
 }
 async function processBulkQueue(){
  const job=await claimBulkJob();
  if(!job)return;
  try{
   if(job.status==='checking_running')await checkBulkJob(job);
   else if(job.status==='applying_running')await applyBulkJob(job);
  }catch(e){
   console.error('bulk keyword job failed',job.id,e);
   await sql("UPDATE filter_bulk_jobs SET status='failed',error_text=$2,updated_at=NOW() WHERE id=$1",[job.id,String(e.message||e).slice(0,300)]);
   await tg('sendMessage',{chat_id:job.private_chat_id,text:'전체적용을 끝내지 못했습니다: '+String(e.message||e).slice(0,160)+'\n적용된 건은 유지됩니다. 개별 설정을 확인해 주세요.'}).catch(()=>{});
  }
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
   if(input.action==='search'){
    await searchGroups(userId,chat,raw);
    return true;
   }
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
   if(act==='bulkconfirm'){await confirmBulk(id,userId,chat);return true}
   if(act==='bulkcancel'){await cancelBulk(id,userId,chat);return true}
   if(act==='search'){
    await setPending(userId,0,'search');
    await display(null,userId,chat,msgId,'🔎 그룹 이름 검색\n\n관리하는 그룹 이름의 일부를 이 개인 채팅에 입력해 주세요.\n그룹이 100개 이상이어도 관리자인 그룹만 검색 결과에 표시됩니다.\n\n10분 내 입력 · 취소: /cancel',[[btn('◀ 내 그룹','wf|list|0')]]);
    return true;
   }
   const groupId=gid(id);
   await requireAdmin(groupId,userId);
   if(act==='group'){await groupMenu(groupId,userId,chat,msgId);return true}
   if(act==='bulk'){await beginBulkPreview(groupId,userId,chat,msgId);return true}
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
 return {handleMessage,handleCallback,processBulkQueue};
}
