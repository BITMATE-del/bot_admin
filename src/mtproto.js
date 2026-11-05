// Optional MTProto integration. Existing Bot API administration remains independent.
import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions';

const apiId = Number(process.env.TELEGRAM_API_ID || 0);
const apiHash = process.env.TELEGRAM_API_HASH || '';
export const mtprotoConfigured = Number.isSafeInteger(apiId) && apiId > 0 && !!apiHash;
let clientPromise;
async function client() {
  if (!mtprotoConfigured) throw Object.assign(new Error('MTProto 사용을 위해 Railway에 TELEGRAM_API_ID와 TELEGRAM_API_HASH를 등록하세요.'), {code:'MTPROTO_NOT_CONFIGURED'});
  if (!clientPromise) {
    clientPromise = (async () => {
      const c = new TelegramClient(new StringSession(''), apiId, apiHash, {connectionRetries:3});
      await c.start({botAuthToken:process.env.BOT_TOKEN});
      return c;
    })().catch(e=>{clientPromise=undefined;throw e});
  }
  return clientPromise;
}
const normalizeUsername=value=>{
  const name=String(value||'').trim().replace(/^https?:\/\/(?:www\.)?t\.me\//i,'').replace(/^@/,'').replace(/\/$/,'');
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(name)) throw new Error('올바른 @사용자명을 입력하세요. (5~32자)');
  return name;
};
export async function resolveTelegramUsername(value) {
  const username=normalizeUsername(value);
  const c=await client();
  const entity=await c.getEntity(username);
  if (!entity || !entity.id || entity.className!=='User') throw new Error('사람의 텔레그램 사용자명을 입력하세요.');
  return {user_id:String(entity.id),first_name:entity.firstName||'',last_name:entity.lastName||'',username:entity.username||username};
}
export async function fetchGroupParticipants({chatId,groupUsername,query='',limit=200}) {
  const c=await client();
  let entity;
  // MTProto requires a channel access hash. A public username resolves it directly.
  if (groupUsername) entity=await c.getInputEntity(groupUsername.replace(/^@/,''));
  else {
    try {entity=await c.getInputEntity(chatId)} catch {
      throw new Error('이 비공개 그룹은 MTProto 접근 정보가 없어 전체 조회가 불가능합니다. 공개 그룹 사용자명이 있는 그룹에서만 동기화할 수 있습니다.');
    }
  }
  const users=[];
  const cap=Math.min(Math.max(Number(limit)||200,1),500);
  let offset=0;
  while(users.length<cap) {
    const batch=Math.min(100,cap-users.length);
    const result=await c.invoke(new Api.channels.GetParticipants({
      channel:entity,
      filter:query?new Api.ChannelParticipantsSearch({q:query}):new Api.ChannelParticipantsRecent({}),
      offset,
      limit:batch,
      hash:BigInt(0)
    }));
    if (!Array.isArray(result.users)||!result.users.length)break;
    for(const u of result.users) if(u.className==='User' && !u.bot && !u.deleted && u.id)users.push({
      user_id:String(u.id), first_name:u.firstName||'',last_name:u.lastName||'',username:u.username||''
    });
    offset+=result.users.length;
    if(result.users.length<batch)break;
  }
  return {users,limit:cap,partial:users.length>=cap};
}
