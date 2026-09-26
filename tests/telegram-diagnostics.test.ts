import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TelegramApi } from '../src/adapters/telegram/api.js';
import { telegramReason,safeFailure } from '../src/adapters/telegram/diagnostics.js';
import { renderText,renderTelegramDigest } from '../src/adapters/telegram/render.js';
import { pollTelegram } from '../src/adapters/telegram/polling.js';
import { TelegramError } from '../src/adapters/telegram/types.js';
import { localDatabase } from '../scripts/local-db.js';
import { createUser } from '../src/services/identity.js';
import { createTelegramRouter } from '../src/adapters/telegram/router.js';
import { FakeTelegram,messageUpdate,telegramFixtureModel } from './fixtures/telegram.js';
import { generateDigest } from '../src/digest/service.js';
import { DIGEST_NOW as now,DIGEST_START,DIGEST_END,digestTestLimits as limits,digestFixtureModel,seedDigestRankings } from './fixtures/digest.js';
import { asUser } from '../src/db/database.js';
import type { Digest } from '../src/digest/types.js';
import { readPreferences,proposePreferences,decideProposal } from '../src/services/preferences.js';

const token='123456:abcdefghijklmnopqrstuvwxyz0123456789';
test('Telegram error descriptions map to fixed safe reasons, never arbitrary prose or secrets',()=>{
  for(const [description,expected] of [
    ["Bad Request: can't parse entities at byte offset 12",'HTML_INVALID'],['Bad Request: BUTTON_DATA_INVALID','CALLBACK_DATA_INVALID'],
    ['Bad Request: photo caption is too long','CAPTION_TOO_LONG'],['Bad Request: message is too long','MESSAGE_TOO_LONG'],
    ['Bad Request: failed to get HTTP URL content https://secret.example/key','PHOTO_FETCH_FAILED'],
    ['Bad Request: wrong type of the web page content','PHOTO_FORMAT_INVALID'],
    ['Unrecognized secret response with private contents','TELEGRAM_REQUEST_REJECTED']]) {
    assert.equal(telegramReason(description,400),expected);
  }
});
test('text error diagnostics retain a useful reason but no token or response body',async()=>{
  const logs:string[]=[];
  const api=new TelegramApi(token,async()=>Response.json({ok:false,error_code:400,description:"Bad Request: can't parse entities SECRET_RESPONSE"},{status:400}),0,s=>logs.push(s));
  await assert.rejects(()=>api.sendMessage('12345',renderText('hello')[0]!),e=>safeFailure(e)==='TELEGRAM_HTTP_400 HTML_INVALID');
  assert.match(logs.join('\n'),/TELEGRAM_SEND_MESSAGE_FAILED: TELEGRAM_HTTP_400 HTML_INVALID/);
  assert.ok(!logs.join('').includes('SECRET_RESPONSE'));assert.ok(!logs.join('').includes(token));
});
test('Telegram transport classifies Worker response failures without leaking body, URL, token or message',async()=>{
  const cases=[
    {name:'network',fetcher:async()=>{throw new TypeError('secret fetch detail');},reason:'NETWORK_FAILED',category:'FETCH_NETWORK_FAILURE'},
    {name:'non-json',fetcher:async()=>new Response('<html>secret proxy page</html>',{status:200,headers:{'content-type':'text/html'}}),reason:'NON_JSON_HTTP_RESPONSE',category:'NON_JSON_HTTP_RESPONSE'},
    {name:'envelope',fetcher:async()=>Response.json({ok:'yes',secret:'provider body'}),reason:'TELEGRAM_ENVELOPE_INVALID',category:'TELEGRAM_ENVELOPE_INVALID'},
    {name:'rejection',fetcher:async()=>Response.json({ok:false,error_code:400,description:'secret rejection'},{status:400}),reason:'TELEGRAM_REQUEST_REJECTED',category:'TELEGRAM_REJECTED'},
    {name:'result',fetcher:async()=>Response.json({ok:true,result:{date:123,secret:'provider body'}}),reason:'RESPONSE_MESSAGE_ID_INVALID',category:'RESULT_SHAPE_INVALID'},
  ] as const;
  for(const item of cases){
    const logs:string[]=[],api=new TelegramApi(token,item.fetcher,0,s=>logs.push(s));
    await assert.rejects(()=>api.sendMessage('12345',renderText('private message')[0]!),e=>safeFailure(e).includes(item.reason));
    const output=logs.join('\n');assert.match(output,new RegExp(item.category));
    for(const forbidden of [token,'api.telegram.org','private message','secret','<html>'])assert.ok(!output.includes(forbidden),`${item.name} leaked ${forbidden}`);
  }
});
test('Telegram transport accepts Cloudflare-style JSON content type and success envelope',async()=>{
  const logs:string[]=[];let requestUrl='',requestInit:RequestInit|undefined;
  const api=new TelegramApi(token,async(url,init)=>{requestUrl=url;requestInit=init;return new Response(JSON.stringify({ok:true,result:{message_id:987,date:1,chat:{id:12345,type:'private'},text:'hello'}}),
    {status:200,headers:{'content-type':'application/json; charset=utf-8'}});},0,s=>logs.push(s));
  assert.equal(await api.sendMessage('12345',renderText('hello')[0]!),987);
  assert.equal(requestUrl,`https://api.telegram.org/bot${token}/sendMessage`);
  assert.equal(requestInit?.method,'POST');assert.equal((requestInit?.headers as Record<string,string>)['content-type'],'application/json');
  assert.ok(requestInit?.signal instanceof AbortSignal);assert.deepEqual(JSON.parse(String(requestInit?.body)),{
    chat_id:'12345',text:'hello',parse_mode:'HTML',link_preview_options:{is_disabled:true}});
  assert.match(logs.join('\n'),/method=sendMessage status=200 content_type=json bytes=\d+ category=TELEGRAM_SUCCESS/);
});
test('definite photo rejection falls back exactly once, with buttons preserved',async()=>{
  for(const status of [400,413,415,422]) {
    const calls:{method:string;body:Record<string,unknown>}[]=[];
    const api=new TelegramApi(token,async(url,init)=>{
      const method=url.split('/').at(-1)!;calls.push({method,body:JSON.parse(String(init.body))});
      return method==='sendPhoto'?Response.json({ok:false,error_code:status,description:'failed to get HTTP URL content'},{status}):Response.json({ok:true,result:{message_id:3}});
    },0);
    const message={...renderText('One story')[0]!,imageUrl:'https://example.com/image.jpg',buttons:[[{text:'Explain',callback_data:'example'}]]};
    assert.equal(await api.sendMessage('12345',message),3);
    assert.deepEqual(calls.map(c=>c.method),['sendPhoto','sendMessage']);
    assert.deepEqual(calls[0]!.body.reply_markup,calls[1]!.body.reply_markup);
  }
});
test('network reset and malformed successful photo response remain uncertain with no text retry',async()=>{
  for(const mode of ['reset','malformed']) {
    const calls:string[]=[],logs:string[]=[];
    const api=new TelegramApi(token,async url=>{
      calls.push(url.split('/').at(-1)!);
      if(mode==='reset')throw Object.assign(new Error('SECRET_SOCKET'),{cause:{code:'ECONNRESET'}});
      return Response.json({ok:true,result:{}});
    },0,s=>logs.push(s));
    await assert.rejects(()=>api.sendMessage('12345',{...renderText('Story')[0]!,imageUrl:'https://example.com/image.jpg'}));
    assert.deepEqual(calls,['sendPhoto']);assert.match(logs.join(' '),/TELEGRAM_SEND_PHOTO_FAILED/);
    if(mode==='reset')assert.match(logs.join(' '),/CONNECTION_RESET/);
    assert.ok(!logs.join(' ').includes('SECRET_SOCKET'));
  }
});
test('simultaneous chat and scheduled sends are serialized, including photo fallback',async()=>{
  const calls:string[]=[];let inFlight=0,maxInFlight=0;
  const api=new TelegramApi(token,async url=>{
    inFlight++;maxInFlight=Math.max(inFlight,maxInFlight);
    await new Promise(r=>setTimeout(r,5));
    const method=url.split('/').at(-1)!;calls.push(method);inFlight--;
    return method==='sendPhoto'?Response.json({ok:false,error_code:400},{status:400}):Response.json({ok:true,result:{message_id:1}});
  },0);
  await Promise.all([api.sendMessage('12345',{...renderText('Photo')[0]!,imageUrl:'https://example.com/image.jpg'}),api.sendMessage('12345',renderText('Text')[0]!)]);
  assert.equal(maxInFlight,1);assert.deepEqual(calls,['sendPhoto','sendMessage','sendMessage']);
});
test('polling reports reset, retry count and recovery; fatal conflicts do not loop',async()=>{
  const logs:string[]=[];let calls=0;
  const controller=new AbortController();
  const transport={...new FakeTelegram(),sendMessage:async()=>1,answerCallback:async()=>{},getUpdates:async()=>{
    if(calls++===0)throw new TelegramError('TELEGRAM_NETWORK_OR_RESPONSE_ERROR',null,'CONNECTION_RESET');
    return [{update_id:1}];
  }};
  await pollTelegram(transport,async()=>true,controller.signal,s=>logs.push(s),async()=>{});
  assert.match(logs[0]!,/CONNECTION_RESET consecutive_failures=1 retry_ms=1000/);
  assert.match(logs[1]!,/TELEGRAM_POLL_RECOVERED/);
  await assert.rejects(()=>pollTelegram({...transport,getUpdates:async()=>{throw new TelegramError('TELEGRAM_HTTP_409',null,'POLLING_CONFLICT');}},async()=>{},controller.signal,s=>logs.push(s),async()=>{}));
  assert.match(logs.at(-1)!,/TELEGRAM_POLL_FATAL.*POLLING_CONFLICT/);
});
test('saved digest render failure produces a safe reply and persists diagnostic without replay',async()=>{
  const db=await localDatabase();try {
    const userId=await createUser(db.owner,'12345');const ranking=await seedDigestRankings(db,userId);
    const digest=(await generateDigest(db.runtime,digestFixtureModel,{userId,operationId:crypto.randomUUID(),rankingOperationIds:[ranking],periodStart:DIGEST_START,periodEnd:DIGEST_END},limits,{},now)).digest!;
    await db.owner.query("UPDATE digests SET document=jsonb_set(document,'{generatedAt}','\"invalid\"'::jsonb) WHERE id=$1",[digest.id]);
    const logs:string[]=[],transport=new FakeTelegram();
    const handle=createTelegramRouter({db:db.runtime,botId:'123456',identities:new Map([['12345',userId]]),transport,ai:null,log:s=>logs.push(s),now:()=>now});
    const update=messageUpdate(1,12345,'/news');assert.equal(await handle(update),'failed');
    assert.match(transport.sent[0]!.message.plain,/could not be displayed/);assert.match(logs[0]!,/TELEGRAM_RENDER_FAILED/);
    const rows=await asUser(db.runtime,userId,tx=>tx.query('SELECT error_code FROM telegram_updates'));
    assert.equal(rows.rows[0]!.error_code,'TELEGRAM_RENDER_INVALID SAVED_DIGEST_INVALID');
    assert.equal(await handle(update),'duplicate');assert.equal(transport.sent.length,1);
  }finally{await db.close();}
});
test('failed plain header persists connection reason and does not attempt story photos or replay',async()=>{
  const db=await localDatabase();try {
    const userId=await createUser(db.owner,'12345'),ranking=await seedDigestRankings(db,userId);
    await generateDigest(db.runtime,digestFixtureModel,{userId,operationId:crypto.randomUUID(),rankingOperationIds:[ranking],periodStart:DIGEST_START,periodEnd:DIGEST_END},limits,{},now);
    const transport=new FakeTelegram();transport.failure=new TelegramError('TELEGRAM_NETWORK_OR_RESPONSE_ERROR',null,'CONNECTION_RESET');
    const handle=createTelegramRouter({db:db.runtime,botId:'123456',identities:new Map([['12345',userId]]),transport,ai:null,now:()=>now});
    const update=messageUpdate(2,12345,'/news');assert.equal(await handle(update),'failed');
    const rows=await asUser(db.runtime,userId,tx=>tx.query('SELECT part,status,error_code FROM telegram_deliveries'));
    assert.equal(rows.rows.length,1);assert.equal(rows.rows[0]!.part,0);assert.equal(rows.rows[0]!.status,'uncertain');assert.match(String(rows.rows[0]!.error_code),/CONNECTION_RESET/);
    transport.failure=null;assert.equal(await handle(update),'duplicate');
    assert.equal(await handle(messageUpdate(3,12345,'/news')),'completed');assert.equal(transport.sent.length,5);
  }finally{await db.close();}
});
test('already saved preference is a normal reply rather than an application failure',async()=>{
  const db=await localDatabase();try {
    const userId=await createUser(db.owner,'12345'),p=await readPreferences(db.runtime,userId);
    const proposal=await proposePreferences(db.runtime,userId,{...p.document,topics:{AI:5}},{now:()=>now});
    await decideProposal(db.runtime,userId,proposal.id,'confirm',{now:()=>now});
    const logs:string[]=[],transport=new FakeTelegram();
    const handle=createTelegramRouter({db:db.runtime,botId:'123456',identities:new Map([['12345',userId]]),transport,ai:{model:telegramFixtureModel(),limits},now:()=>now,log:s=>logs.push(s)});
    assert.equal(await handle(messageUpdate(4,12345,'Give me more AI news')),'completed');
    assert.match(transport.sent[0]!.message.plain,/already set/);assert.deepEqual(logs,['TELEGRAM_PREFERENCE_ALREADY_SET']);
  }finally{await db.close();}
});
test('legacy digest images are optional and invalid stored shape is rejected safely',()=>{
  const old={id:crypto.randomUUID(),generatedAt:now.toISOString(),title:'Briefing',sections:[{name:'News',items:[{headline:'Title',summary:'Summary.',whyItMatters:'Impact.',sources:[{name:'Source',url:'https://example.com/news'}]}]}]} as Digest;
  const messages=renderTelegramDigest(old);assert.equal(messages.length,2);assert.ok(messages.every(m=>!m.imageUrl));
  assert.throws(()=>renderTelegramDigest({...old,sections:null} as unknown as Digest),/TELEGRAM_RENDER_INVALID/);
});
