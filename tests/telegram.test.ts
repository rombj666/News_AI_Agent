import assert from 'node:assert/strict';
import { test,before,after } from 'node:test';
import { localDatabase } from '../scripts/local-db.js';
import { asUser,type Database } from '../src/db/database.js';
import { createUser } from '../src/services/identity.js';
import { readPreferences,proposePreferences,decideProposal } from '../src/services/preferences.js';
import { createConversation,saveMessage } from '../src/services/history.js';
import { generateDigest } from '../src/digest/service.js';
import { createTelegramRouter,parseCallback } from '../src/adapters/telegram/router.js';
import { renderTelegramDigest,renderText } from '../src/adapters/telegram/render.js';
import { telegramConfig } from '../src/adapters/telegram/config.js';
import { TelegramApi } from '../src/adapters/telegram/api.js';
import { pollTelegram } from '../src/adapters/telegram/polling.js';
import { TelegramError } from '../src/adapters/telegram/types.js';
import { respondToNews } from '../src/services/news-assistant.js';
import { ModelError } from '../src/ai/openai.js';
import type { LanguageModel } from '../src/domain/ports.js';
import { LUNA_MODEL } from '../src/config/index.js';
import { FakeTelegram,telegramFixtureModel,messageUpdate,callbackUpdate } from './fixtures/telegram.js';
import { DIGEST_NOW as now,DIGEST_START,DIGEST_END,digestTestLimits as limits,digestFixtureModel,seedDigestRankings } from './fixtures/digest.js';

let db:Awaited<ReturnType<typeof localDatabase>>,counter=88000;
before(async()=>{db=await localDatabase();});after(async()=>{await db?.close();});
async function fixture(withDigest=false,provider:LanguageModel=telegramFixtureModel(),database?:Database) {
  const telegramId=++counter,userId=await createUser(db.owner,String(telegramId));
  const transport=new FakeTelegram(),logs:string[]=[];
  const identities=new Map([[String(telegramId),userId]]);
  const handle=createTelegramRouter({db:database??db.runtime,botId:'123456',identities,transport,ai:{model:provider,limits},now:()=>now,log:code=>logs.push(code)});
  let digest:Awaited<ReturnType<typeof generateDigest>>['digest']=null;
  if(withDigest) {
    const rankingId=await seedDigestRankings(db,userId);
    digest=(await generateDigest(db.runtime,digestFixtureModel,{userId,operationId:crypto.randomUUID(),rankingOperationIds:[rankingId],
      periodStart:DIGEST_START,periodEnd:DIGEST_END},limits,{},now)).digest;
  }
  return {telegramId,userId,transport,logs,identities,handle,digest};
}
const last=(transport:FakeTelegram)=>transport.sent.at(-1)!.message;
const ownRows=(userId:string,table:string)=>asUser(db.runtime,userId,tx=>tx.query(`SELECT * FROM ${table}`));
function faultDatabase(match:string):Database {
  return {...db.runtime,transaction:work=>db.runtime.transaction(tx=>work({...tx,query:async(sql,params)=>{
    if(sql.includes(match)) throw Error('secret SQL details');return tx.query(sql,params);
  }}))};
}

test('authorized /start links existing identity without duplicate user or preferences',async()=>{
  const f=await fixture();
  assert.equal(await createUser(db.owner,String(f.telegramId)),f.userId);
  assert.equal(await f.handle(messageUpdate(1,f.telegramId,'/start')),'completed');
  assert.match(last(f.transport).plain,/Welcome to My News AI/);
  assert.equal((await ownRows(f.userId,'telegram_sessions')).rows.length,1);
  assert.equal((await ownRows(f.userId,'user_preferences')).rows.length,1);
});
test('unauthorized user receives safe denial with no user linking, private reads or AI calls',async()=>{
  const model=telegramFixtureModel(),f=await fixture(false,model);
  assert.equal(await f.handle(messageUpdate(2,998877,'Give me more AI news.')),'unauthorized');
  assert.match(last(f.transport).plain,/not authorized/);assert.equal(model.calls,0);
  assert.equal((await ownRows(f.userId,'telegram_updates')).rows.length,0);
  assert.equal((await db.owner.query("SELECT id FROM users WHERE telegram_user_id='998877'")).rows.length,0);
});
test('groups, bot senders and mismatched private chat IDs cannot expose user data',async()=>{
  const f=await fixture();
  const group=messageUpdate(3,f.telegramId,'/preferences');group.message.chat.type='group';group.message.chat.id=-900;
  const spoof=messageUpdate(4,f.telegramId,'/preferences');spoof.message.chat.id=123;
  const bot=messageUpdate(5,f.telegramId,'/news');bot.message.from.is_bot=true;
  for(const update of [group,spoof,bot]) assert.equal(await f.handle(update),'ignored');
  assert.equal(f.transport.sent.length,0);
});
test('disabled application user cannot use protected commands or AI',async()=>{
  const model=telegramFixtureModel(),f=await fixture(false,model);
  await db.owner.query("UPDATE users SET status='disabled' WHERE id=$1",[f.userId]);
  assert.equal(await f.handle(messageUpdate(6,f.telegramId,'/preferences')),'unauthorized');
  assert.equal(model.calls,0);assert.match(last(f.transport).plain,/not authorized/);
});
test('/news without a digest never generates or retrieves news',async()=>{
  const model=telegramFixtureModel(),f=await fixture(false,model);
  await f.handle(messageUpdate(7,f.telegramId,'/news'));
  assert.equal(last(f.transport).plain,'Your news briefing is not ready yet.');assert.equal(model.calls,0);
  assert.equal((await ownRows(f.userId,'ai_usage')).rows.length,0);
});
for(const code of ['MODEL_TIMEOUT','MODEL_NETWORK_OR_RESPONSE_ERROR','PREFERENCE_OUTPUT_INVALID','MODEL_OUTPUT_OR_PROVIDER_ERROR']) {
  test(`preference failure logs ${code}, retains unknown reservation and cannot replay`,async()=>{
    let calls=0;
    const f=await fixture(false,{model:LUNA_MODEL,generate:async()=>{calls++;throw new ModelError(code);}});
    const before=await readPreferences(db.runtime,f.userId),update=messageUpdate(900+f.telegramId,f.telegramId,'Give me more AI news');
    assert.equal(await f.handle(update),'failed');
    assert.deepEqual(f.logs,[`TELEGRAM_APPLICATION_REQUEST_FAILED: ${code}`]);
    assert.equal(last(f.transport).plain,"I couldn't process that request right now.");
    const usage=(await ownRows(f.userId,'ai_usage')).rows[0]!;
    assert.equal(usage.status,'unknown');assert.equal(usage.estimated_cost_nanodollars,null);
    assert.ok(BigInt(String(usage.reserved_cost_nanodollars))>0n);assert.equal(usage.error_code,code);
    const job=(await ownRows(f.userId,'job_runs')).rows[0]!;
    assert.equal(job.status,'failed');assert.equal(job.error_code,code);
    assert.deepEqual(await readPreferences(db.runtime,f.userId),before);
    assert.equal((await ownRows(f.userId,'pending_preference_changes')).rows.length,0);
    assert.equal(await f.handle(update),'duplicate');assert.equal(calls,1);
  });
}
test('/news sends the saved digest and source buttons without model calls',async()=>{
  const model=telegramFixtureModel(),f=await fixture(true,model);
  await f.handle(messageUpdate(8,f.telegramId,'/news'));
  assert.equal(model.calls,0);assert.equal(f.transport.sent.length,5);
  const buttons=f.transport.sent.flatMap(s=>s.message.buttons?.flat()??[]);
  assert.equal(buttons.filter(b=>b.text==='Explain').length,4);
  assert.ok(buttons.some(b=>'url' in b&&b.url.startsWith('https://example.com/digest/')));
  assert.ok(buttons.every(b=>!('callback_data' in b)||Buffer.byteLength(b.callback_data)<=64));
  assert.equal((await ownRows(f.userId,'telegram_sessions')).rows[0]!.current_digest_id,f.digest!.id);
  assert.ok((await ownRows(f.userId,'telegram_deliveries')).rows.every(row=>row.status==='sent'));
});
test('/preferences and /help return concise user-facing summaries, with no AI',async()=>{
  const model=telegramFixtureModel(),f=await fixture(false,model);
  await f.handle(messageUpdate(9,f.telegramId,'/preferences'));
  assert.match(last(f.transport).plain,/Topics: Not set/);assert.doesNotMatch(last(f.transport).plain,/user_id|version|created_at/);
  await f.handle(messageUpdate(10,f.telegramId,'/help'));assert.equal(last(f.transport).plain,'Use /start to see your settings and examples.');assert.equal(model.calls,0);
});
test('HTML renderer splits long stories safely and preserves source URLs in buttons',async()=>{
  const f=await fixture(true);const digest=structuredClone(f.digest!);
  const item=digest.sections[0]!.items[0]!;
  item.headline='<script>bad</script> & <b>bold</b>';
  item.summary=('🛰️ <tag> & word ').repeat(900);item.whyItMatters='word '.repeat(1200);
  item.sources[0]!.url='https://example.com/story?x=1&y=2';
  const messages=renderTelegramDigest(digest);
  assert.ok(messages.length>5);assert.ok(messages.every(m=>m.html.length<=4096));
  assert.ok(messages.every(m=>!m.html.includes('<script>')&&!m.html.includes('<b>')));
  assert.ok(messages.some(m=>m.html.includes('&lt;script&gt;')));
  assert.ok(messages.flatMap(m=>m.buttons?.flat()??[]).some(b=>'url' in b&&b.url==='https://example.com/story?x=1&y=2'));
  assert.ok(messages.every(m=>!m.html.includes('1\\.')));
  assert.ok(renderText('a'.repeat(10000)).every(m=>m.html.length<=4096));
});
test('More/Less buttons store one structured feedback row without changing preferences or calling AI',async()=>{
  const model=telegramFixtureModel(),f=await fixture(true,model);
  await f.handle(callbackUpdate(11,f.telegramId,`m:${f.digest!.id}:1`));
  assert.equal((await ownRows(f.userId,'user_feedback')).rows[0]!.direction,'more');
  await f.handle(callbackUpdate(12,f.telegramId,`l:${f.digest!.id}:1`));
  const rows=(await ownRows(f.userId,'user_feedback')).rows;
  assert.equal(rows.length,1);assert.equal(rows[0]!.direction,'less');
  assert.equal((await readPreferences(db.runtime,f.userId)).version,1);assert.equal(model.calls,0);
});
test('Explain is metered against stored context and repeated button actions reuse the result',async()=>{
  const model=telegramFixtureModel(),f=await fixture(true,model);
  const conversation=await createConversation(db.runtime,f.userId);
  await saveMessage(db.runtime,f.userId,{conversationId:conversation,role:'user',content:'PRIVATE_HISTORY_SENTINEL',createdAt:now});
  await f.handle(callbackUpdate(13,f.telegramId,`e:${f.digest!.id}:1`));
  assert.match(last(f.transport).plain,/saved briefing/);
  await f.handle(callbackUpdate(14,f.telegramId,`e:${f.digest!.id}:1`));
  assert.equal(model.calls,1);assert.ok(!JSON.stringify(model.contexts).includes('PRIVATE_HISTORY_SENTINEL'));
  const rows=(await ownRows(f.userId,'ai_usage')).rows.filter(row=>row.job_type==='news_explanation');
  assert.equal(rows.length,1);assert.equal(rows[0]!.status,'succeeded');assert.equal(Number(rows[0]!.estimated_cost_nanodollars),114200);
});
test('natural-language story question uses the displayed digest; unsupported live search never calls AI',async()=>{
  const model=telegramFixtureModel(),f=await fixture(true,model);
  await f.handle(messageUpdate(15,f.telegramId,'/news'));
  await f.handle(messageUpdate(16,f.telegramId,'Why is story 2 important?'));
  assert.equal(model.calls,1);assert.match(last(f.transport).plain,/saved briefing/);
  await f.handle(messageUpdate(17,f.telegramId,'Search what happened with Nvidia five minutes ago.'));
  assert.match(last(f.transport).plain,/Live search is not enabled/);assert.equal(model.calls,1);
});
test('preference proposal is pending until owner confirmation and is separately usage-accounted',async()=>{
  const model=telegramFixtureModel(),f=await fixture(false,model);
  await f.handle(messageUpdate(18,f.telegramId,'Give me more AI news.'));
  const proposal=(await ownRows(f.userId,'pending_preference_changes')).rows[0]!;
  assert.equal((await readPreferences(db.runtime,f.userId)).document.topics.AI,undefined);
  assert.match(last(f.transport).plain,/unset → 5/);
  assert.equal(last(f.transport).buttons![0]![0]!.text,'Confirm');
  await f.handle(callbackUpdate(19,f.telegramId,`c:${proposal.id}`));
  assert.equal((await readPreferences(db.runtime,f.userId)).document.topics.AI,5);
  assert.equal(model.calls,1);
  assert.equal((await ownRows(f.userId,'ai_usage')).rows[0]!.job_type,'preference_interpretation');
  await f.handle(callbackUpdate(20,f.telegramId,`c:${proposal.id}`));
  assert.equal((await readPreferences(db.runtime,f.userId)).version,2);
});
test('Cancel discards the pending proposal without changing preferences',async()=>{
  const f=await fixture();await f.handle(messageUpdate(21,f.telegramId,'Stop showing football.'));
  const proposal=(await ownRows(f.userId,'pending_preference_changes')).rows[0]!;
  await f.handle(callbackUpdate(22,f.telegramId,`x:${proposal.id}`));
  assert.deepEqual((await readPreferences(db.runtime,f.userId)).document.exclusions,[]);
  assert.equal((await ownRows(f.userId,'pending_preference_changes')).rows[0]!.status,'cancelled');
});
test('temporary or ambiguous-duration preference requests do not become permanent proposals',async()=>{
  const model=telegramFixtureModel(),f=await fixture(false,model);
  await f.handle(messageUpdate(23,f.telegramId,'Give me more AI news this week.'));
  assert.match(last(f.transport).plain,/Temporary interests/);assert.equal(model.calls,0);
  assert.equal((await ownRows(f.userId,'pending_preference_changes')).rows.length,0);
});
test('duplicate Telegram update and callback query ID cannot repeat history, feedback or AI',async()=>{
  const model=telegramFixtureModel(),f=await fixture(true,model);
  const update=callbackUpdate(24,f.telegramId,`e:${f.digest!.id}:1`,'same-callback');
  await f.handle(update);const count=f.transport.sent.length;
  assert.equal(await f.handle(update),'duplicate');
  assert.equal(await f.handle({...update,update_id:25}),'duplicate');
  assert.equal(model.calls,1);assert.equal(f.transport.sent.length,count);
  assert.equal((await ownRows(f.userId,'telegram_updates')).rows.length,1);
  assert.equal((await ownRows(f.userId,'messages')).rows.length,2);
});
test('malformed callbacks and foreign-user story/proposal IDs never run AI or mutate other users',async()=>{
  const a=await fixture(true),model=telegramFixtureModel(),b=await fixture(false,model);
  await b.handle(callbackUpdate(26,b.telegramId,'malformed:secret'));assert.match(last(b.transport).plain,/not supported/);
  await b.handle(callbackUpdate(27,b.telegramId,`e:${a.digest!.id}:1`));assert.match(last(b.transport).plain,/not available/);
  const profile=await readPreferences(db.runtime,a.userId);
  const proposal=await proposePreferences(db.runtime,a.userId,{...profile.document,topics:{AI:5}},{now:()=>now});
  await b.handle(callbackUpdate(28,b.telegramId,`c:${proposal.id}`));
  assert.equal((await readPreferences(db.runtime,a.userId)).version,1);assert.equal(model.calls,0);
  assert.equal(parseCallback(`E:${a.digest!.id}:1`),null);
  assert.equal(parseCallback(`e:${a.digest!.id}:999`),null);
});
test('expired and stale confirmation callbacks cannot save a preference',async()=>{
  const f=await fixture();const profile=await readPreferences(db.runtime,f.userId);
  const expired=await proposePreferences(db.runtime,f.userId,{...profile.document,topics:{AI:5}},{now:()=>new Date(+now-16*60000)});
  await f.handle(callbackUpdate(29,f.telegramId,`c:${expired.id}`));assert.match(last(f.transport).plain,/expired/);
  const stale=await proposePreferences(db.runtime,f.userId,{...profile.document,topics:{AI:4}},{now:()=>now});
  const fresh=await proposePreferences(db.runtime,f.userId,{...profile.document,topics:{Science:3}},{now:()=>now});
  await decideProposal(db.runtime,f.userId,fresh.id,'confirm',{now:()=>now});
  await f.handle(callbackUpdate(30,f.telegramId,`c:${stale.id}`));assert.match(last(f.transport).plain,/changed/);
  assert.equal((await readPreferences(db.runtime,f.userId)).document.topics.AI,undefined);
});
test('provider failure and budget rejection give safe replies with appropriate accounting',async()=>{
  const f=await fixture(false,{model:LUNA_MODEL,generate:async()=>{throw Error('private provider SQL key=secret');}});
  await f.handle(messageUpdate(31,f.telegramId,'Give me more AI news.'));
  assert.equal(last(f.transport).plain,"I couldn't process that request right now.");
  assert.ok(!f.logs.join(' ').includes('secret'));
  assert.equal((await ownRows(f.userId,'ai_usage')).rows[0]!.status,'unknown');
  const model=telegramFixtureModel(),b=await fixture(false,model);
  const handle=createTelegramRouter({db:db.runtime,botId:'123456',identities:b.identities,transport:b.transport,
    ai:{model,limits:{monthlyBudgetNanodollars:1n,budgetScope:'conversation'}},now:()=>now,log:code=>b.logs.push(code)});
  await handle(messageUpdate(32,b.telegramId,'Give me more AI news.'));
  assert.equal(last(b.transport).plain,'The AI request is temporarily unavailable.');assert.equal(model.calls,0);
  assert.equal((await ownRows(b.userId,'ai_usage')).rows.length,0);
  assert.deepEqual(b.logs,['TELEGRAM_APPLICATION_REQUEST_FAILED: PREFERENCE_BUDGET_EXCEEDED']);
});
test('conversation persistence reuses messages and stores Telegram metadata separately under RLS',async()=>{
  const f=await fixture();await f.handle(messageUpdate(33,f.telegramId,'/start'));await f.handle(messageUpdate(34,f.telegramId,'/help'));
  const messages=(await ownRows(f.userId,'messages')).rows;
  assert.equal(messages.length,4);assert.equal(new Set(messages.map(row=>row.conversation_id)).size,1);
  assert.equal(messages.filter(row=>row.role==='user').length,2);
  const other=await fixture();
  for(const table of ['telegram_sessions','telegram_updates','telegram_deliveries','user_feedback']) {
    assert.equal((await db.runtime.query(`SELECT * FROM ${table}`)).rows.length,0);
    assert.equal((await ownRows(other.userId,table)).rows.length,0);
  }
});
test('uncertain send is recorded and never automatically resent on duplicate update',async()=>{
  const f=await fixture();f.transport.failure=new TelegramError('TELEGRAM_NETWORK_OR_RESPONSE_ERROR');
  const update=messageUpdate(35,f.telegramId,'/start');assert.equal(await f.handle(update),'failed');
  assert.equal((await ownRows(f.userId,'telegram_deliveries')).rows[0]!.status,'uncertain');
  f.transport.failure=null;assert.equal(await f.handle(update),'duplicate');assert.equal(f.transport.sent.length,0);
});
test('update claim failure rolls back history and prevents all external work',async()=>{
  const f=await fixture(false,telegramFixtureModel(),faultDatabase('INSERT INTO telegram_updates'));
  await assert.rejects(()=>f.handle(messageUpdate(36,f.telegramId,'/start')),/secret SQL/);
  assert.equal(f.transport.sent.length,0);assert.equal((await ownRows(f.userId,'messages')).rows.length,0);
  assert.equal((await ownRows(f.userId,'telegram_sessions')).rows.length,0);
});
test('local Telegram configuration requires allowlist but not a webhook secret; AI and test gates are separate',()=>{
  const token='123456:abcdefghijklmnopqrstuvwxyz0123456789';
  assert.throws(()=>telegramConfig({},'whoami'),/TELEGRAM_BOT_TOKEN/);
  assert.equal(telegramConfig({TELEGRAM_BOT_TOKEN:token},'whoami').aiEnabled,false);
  assert.throws(()=>telegramConfig({TELEGRAM_BOT_TOKEN:token},'dev'),/ALLOWED_USER_IDS/);
  const config=telegramConfig({TELEGRAM_BOT_TOKEN:token,TELEGRAM_ALLOWED_USER_IDS:'123, 456,123'},'dev');
  assert.deepEqual(config.allowedIds,['123','456']);assert.equal(config.aiEnabled,false);
  assert.throws(()=>telegramConfig({TELEGRAM_BOT_TOKEN:token,TELEGRAM_ALLOWED_USER_IDS:'123'},'test'),/RUN_LIVE_TELEGRAM/);
  assert.throws(()=>telegramConfig({TELEGRAM_BOT_TOKEN:token,TELEGRAM_ALLOWED_USER_IDS:'123',TELEGRAM_AI_ENABLED:'YES'},'dev'),/OPENAI_API_KEY/);
});
test('Telegram API uses safe HTML, bounded callbacks and long polling with mocked HTTP only',async()=>{
  const methods:string[]=[],bodies:Record<string,unknown>[]=[];
  const api=new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz0123456789',async(url,init)=>{
    const method=url.split('/').at(-1)!;methods.push(method);bodies.push(JSON.parse(String(init.body)));
    return Response.json({ok:true,result:method==='getUpdates'?[]:method==='sendMessage'?{message_id:123}:true});
  },0);
  await api.getUpdates(5,new AbortController().signal);
  assert.equal(await api.sendMessage('123',renderText('A < B & C')[0]!),123);
  await api.answerCallback('cb','Received');
  assert.deepEqual(methods,['getUpdates','sendMessage','answerCallbackQuery']);
  assert.equal(bodies[0]!.timeout,25);assert.equal(bodies[0]!.offset,5);
  assert.equal(bodies[1]!.parse_mode,'HTML');assert.equal(bodies[1]!.text,'A &lt; B &amp; C');
});
test('Telegram HTTP failures never expose token, URL or provider response body',async()=>{
  const api=new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz0123456789',async()=>new Response('secret provider body',{status:401}),0);
  await assert.rejects(()=>api.getUpdates(0,new AbortController().signal),e=>String(e).includes('TELEGRAM_HTTP_401')&&!String(e).includes('secret')&&!String(e).includes('abcdef'));
});
test('polling retries reads, advances offsets after processing and exits on callback/abort',async()=>{
  const transport=new FakeTelegram(),offsets:number[]=[],waits:number[]=[];let calls=0;
  const polling={...transport,sendMessage:transport.sendMessage.bind(transport),answerCallback:transport.answerCallback.bind(transport),
    async getUpdates(offset:number) {offsets.push(offset);calls++;if(calls===1)throw new TelegramError('TELEGRAM_HTTP_500');return [{update_id:calls===2?40:41}];}};
  const seen:number[]=[];
  await pollTelegram(polling,async raw=>{seen.push((raw as {update_id:number}).update_id);return seen.length===2;},new AbortController().signal,()=>{},async ms=>{waits.push(ms);});
  assert.deepEqual(offsets,[0,0,41]);assert.deepEqual(seen,[40,41]);assert.deepEqual(waits,[1000]);
});
test('polling does not acknowledge failed persistence and rejects webhook/conflicting pollers safely',async()=>{
  const transport=new FakeTelegram();
  const polling={sendMessage:transport.sendMessage.bind(transport),answerCallback:transport.answerCallback.bind(transport),async getUpdates(){return [{update_id:50}];}};
  await assert.rejects(()=>pollTelegram(polling,async()=>{throw Error('DB failure');},new AbortController().signal),/DB failure/);
  await assert.rejects(()=>pollTelegram({...polling,async getUpdates(){throw new TelegramError('TELEGRAM_HTTP_409');}},async()=>{},new AbortController().signal),/409/);
});
test('AI-disabled mode still supports commands and cannot interpret or explain',async()=>{
  const f=await fixture(true),handle=createTelegramRouter({db:db.runtime,botId:'123456',identities:f.identities,transport:f.transport,ai:null,now:()=>now});
  await handle(messageUpdate(51,f.telegramId,'Give me more AI news.'));
  assert.match(last(f.transport).plain,/AI replies are not enabled/);
  await handle(callbackUpdate(52,f.telegramId,`e:${f.digest!.id}:1`));
  assert.match(last(f.transport).plain,/AI replies are not enabled/);
});
test('preference interpretation cannot overwrite changes made while the model was running',async()=>{
  const f=await fixture();const model=telegramFixtureModel();
  const provider={model:LUNA_MODEL,async generate(input:Parameters<LanguageModel['generate']>[0]) {
    const current=await readPreferences(db.runtime,f.userId);
    const proposal=await proposePreferences(db.runtime,f.userId,{...current.document,language:'fr'},{now:()=>now});
    await decideProposal(db.runtime,f.userId,proposal.id,'confirm',{now:()=>now});
    return model.generate(input);
  }};
  await assert.rejects(()=>respondToNews(db.runtime,{userId:f.userId,operationId:crypto.randomUUID(),text:'Give me more AI news.'},{model:provider,limits},now),/STALE/);
  assert.equal((await readPreferences(db.runtime,f.userId)).document.language,'fr');
  assert.equal((await readPreferences(db.runtime,f.userId)).document.topics.AI,undefined);
});
test('failed explanation with reported usage is accounted without saving invented model output',async()=>{
  const provider:LanguageModel={model:LUNA_MODEL,async generate(){throw new ModelError('MODEL_INCOMPLETE',{text:'',usage:{inputTokens:100,cachedInputTokens:0,outputTokens:20},requestId:'resp_fixture'});}};
  const f=await fixture(true,provider);await f.handle(callbackUpdate(53,f.telegramId,`e:${f.digest!.id}:1`));
  assert.match(last(f.transport).plain,/couldn't process/);
  const row=(await ownRows(f.userId,'ai_usage')).rows.find(r=>r.job_type==='news_explanation')!;
  assert.equal(row.status,'failed');assert.equal(Number(row.estimated_cost_nanodollars),44000);
});

test('Telegram rate limits preserve retry_after without exposing server descriptions',async()=>{
  const api=new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz0123456789',async()=>Response.json({ok:false,error_code:429,
    description:'secret body',parameters:{retry_after:45}},{status:429}),0);
  await assert.rejects(()=>api.getUpdates(0,new AbortController().signal),e=>e instanceof TelegramError&&e.retryAfterMs===45000&&!String(e).includes('secret'));
  const transport=new FakeTelegram();let calls=0;const delays:number[]=[];
  await pollTelegram({sendMessage:transport.sendMessage.bind(transport),answerCallback:transport.answerCallback.bind(transport),
    async getUpdates(){if(++calls===1)throw new TelegramError('TELEGRAM_HTTP_429',45000);return [{update_id:60}];}},
  async()=>true,new AbortController().signal,()=>{},async ms=>{delays.push(ms);});
  assert.deepEqual(delays,[45000]);
});
test('preference interpretation sends only mentioned settings and rejects malformed output without proposals',async()=>{
  const f=await fixture(),current=await readPreferences(db.runtime,f.userId);
  const proposal=await proposePreferences(db.runtime,f.userId,{...current.document,topics:{AI:4,PrivateUnrelatedTopic:5},regions:{PrivateRegion:5}},{now:()=>now});
  await decideProposal(db.runtime,f.userId,proposal.id,'confirm',{now:()=>now});
  const model:LanguageModel={model:LUNA_MODEL,async generate(input){
    const context=JSON.parse(input.context);assert.deepEqual(context.preferences.topics,{AI:4});assert.deepEqual(context.preferences.regions,{});
    assert.ok(!input.context.includes('PrivateUnrelatedTopic'));return {text:'malformed',usage:null,requestId:null};
  }};
  const handle=createTelegramRouter({db:db.runtime,botId:'123456',identities:f.identities,transport:f.transport,ai:{model,limits},now:()=>now});
  await handle(messageUpdate(61,f.telegramId,'Give me more AI news.'));
  assert.match(last(f.transport).plain,/couldn't process/);
  assert.equal((await ownRows(f.userId,'pending_preference_changes')).rows.filter(r=>r.status==='pending').length,0);
});
test('Telegram explanation timeout is unknown usage and duplicate updates cannot retry the billable call',async()=>{
  let calls=0;const model:LanguageModel={model:LUNA_MODEL,generate:()=>{calls++;return new Promise(()=>{});}};
  const f=await fixture(true,model),handle=createTelegramRouter({db:db.runtime,botId:'123456',identities:f.identities,transport:f.transport,
    ai:{model,limits:{...limits,timeoutMs:5}},now:()=>now});
  const update=callbackUpdate(62,f.telegramId,`e:${f.digest!.id}:1`);
  await handle(update);await handle(update);assert.equal(calls,1);
  const usage=(await ownRows(f.userId,'ai_usage')).rows.find(r=>r.job_type==='news_explanation')!;
  assert.equal(usage.status,'unknown');assert.equal(usage.estimated_cost_nanodollars,null);assert.ok(Number(usage.reserved_cost_nanodollars)>0);
});
test('partially delivered digest keeps story-number context on the visible new briefing',async()=>{
  const f=await fixture(true);let attempts=0;const send=f.transport.sendMessage.bind(f.transport);
  f.transport.sendMessage=async(chat,message)=>{
    if(++attempts===3)throw new TelegramError('TELEGRAM_NETWORK_OR_RESPONSE_ERROR');return send(chat,message);
  };
  assert.equal(await f.handle(messageUpdate(63,f.telegramId,'/news')),'failed');
  assert.equal((await ownRows(f.userId,'telegram_sessions')).rows[0]!.current_digest_id,f.digest!.id);
  assert.equal(f.transport.sent.length,2);
});
