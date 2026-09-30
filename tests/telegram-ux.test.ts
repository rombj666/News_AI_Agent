import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startSummary,preferenceSummary,classifyMessage,respondToNews } from '../src/services/news-assistant.js';
import { initialPreferences } from '../src/domain/preferences.js';
import { safeImageUrl } from '../src/retrieval/images.js';
import { TelegramApi } from '../src/adapters/telegram/api.js';
import { renderText,renderTelegramDigest } from '../src/adapters/telegram/render.js';
import { RssRetriever } from '../src/retrieval/rss.js';
import { localDatabase } from '../scripts/local-db.js';
import { createUser } from '../src/services/identity.js';
import { readPreferences,decideProposal } from '../src/services/preferences.js';
import { telegramFixtureModel } from './fixtures/telegram.js';
import { DIGEST_NOW as now,digestTestLimits as limits,seedDigestRankings,digestFixtureModel,DIGEST_START,DIGEST_END } from './fixtures/digest.js';
import { generateDigest } from '../src/digest/service.js';
import { asUser } from '../src/db/database.js';

test('start and detailed preferences use saved schedule, disabled state and empty settings',()=>{
  const p=initialPreferences();
  assert.match(startSummary(p),/Disabled.*7:00 AM/);assert.match(startSummary(p),/One-time news requests do not change/);assert.doesNotMatch(startSummary(p),/\/help/);
  p.deliveryEnabled=true;p.deliveryTime='18:30';p.timezone='Europe/London';p.topics={AI:5};p.regions={UK:4};p.exclusions=['Football'];
  const text=startSummary(p);assert.match(text,/Enabled.*6:30 PM/);assert.match(text,/Europe\/London/);assert.match(text,/fresh personalized news/);
  assert.match(preferenceSummary(p),/Delivery time: 18:30\nTimezone: Europe\/London/);
});
test('all requested schedule phrases route to preference interpretation; deeper followups route to questions',()=>{
  for(const text of ['Send my news at 8:30 AM every morning','Change my briefing to 6 PM','Stop automatic delivery','Turn automatic delivery back on','Use UK time','Make my digest quick','Send me a deep digest'])assert.equal(classifyMessage(text),/digest/.test(text)?'PERMANENT_PREFERENCE':'SCHEDULE_CHANGE');
  assert.equal(classifyMessage('Explain deeper'),'STORY_QUESTION');
});
test('schedule proposals use existing confirmation, cancel, ownership and accounting',async()=>{
  const db=await localDatabase();try {
    const userId=await createUser(db.owner,'12345');
    for(const [action,value,field] of [['delivery_time','08:30','deliveryTime'],['delivery_enabled','true','deliveryEnabled'],['timezone','Europe/London','timezone'],['digest_length','quick','digestLength']] as const) {
      const model={...telegramFixtureModel(),generate:async()=>({text:JSON.stringify({action,value,key:null,priority:null,scope:'permanent',clarification:null}),usage:{inputTokens:100,cachedInputTokens:0,outputTokens:50},requestId:'resp_fixture'})};
      const before=await readPreferences(db.runtime,userId);
      const reply=await respondToNews(db.runtime,{userId,operationId:crypto.randomUUID(),text:'Change my briefing time'}, {model,limits},now);
      assert.equal(reply.kind,'proposal');if(reply.kind!=='proposal')throw Error('missing proposal');
      assert.deepEqual((await readPreferences(db.runtime,userId)).document,before.document);
      await decideProposal(db.runtime,userId,reply.proposalId,'cancel',{now:()=>now});
      assert.deepEqual((await readPreferences(db.runtime,userId)).document,before.document);
      const next=await respondToNews(db.runtime,{userId,operationId:crypto.randomUUID(),text:'Change my briefing time'},{model,limits},now);
      if(next.kind!=='proposal')throw Error('missing proposal');
      await decideProposal(db.runtime,userId,next.proposalId,'confirm',{now:()=>now});
      assert.equal((await readPreferences(db.runtime,userId)).document[field],field==='deliveryEnabled'?true:value);
      await assert.rejects(()=>decideProposal(db.runtime,userId,next.proposalId,'confirm',{now:()=>now}));
    }
    const usage=await asUser(db.runtime,userId,tx=>tx.query('SELECT * FROM ai_usage'));
    assert.equal(usage.rows.length,8);assert.ok(usage.rows.every(r=>r.job_type==='preference_interpretation'&&r.estimated_cost_nanodollars!==null));
  }finally{await db.close();}
});
test('unsafe image URLs are dropped without rejecting the article',()=>{
  for(const url of ['http://example.com/a.jpg','https://localhost/a.jpg','https://127.0.0.1/a.jpg','https://a:b@example.com/a.jpg','https://example.com/a.jpg?token=secret','https://example.com/'+ 'x'.repeat(2048)])assert.equal(safeImageUrl(url),null);
  assert.equal(safeImageUrl('https://example.com/a.jpg'),'https://example.com/a.jpg');
});
test('RSS takes source media/enclosure images without fetching pages or binaries',async()=>{
  const source={id:'test-media',name:'Test',url:'https://example.com/rss',enabled:true,category:'world'};
  const rss=new RssRetriever(source,async()=>new Response('<rss><channel><item><title>News</title><link>https://example.com/news</link><enclosure url="https://example.com/a.jpg" type="image/jpeg" /></item></channel></rss>'),{now:()=>now});
  const batch=await rss.collect({query:'',since:new Date(+now-86400000),limit:3,signal:new AbortController().signal});
  assert.equal(batch.items[0]?.imageUrl,'https://example.com/a.jpg');
});
test('photo success, definite rejection fallback, invalid URLs, long captions and uncertain sends',async()=>{
  const token='123456:abcdefghijklmnopqrstuvwxyz0123456789';
  for(const mode of ['success','rejected','uncertain','invalid','long'] as const) {
    const methods:string[]=[],logs:string[]=[];
    const api=new TelegramApi(token,async(url)=>{
      const method=url.split('/').at(-1)!;methods.push(method);
      if(method==='sendPhoto'&&mode==='uncertain')throw Error('network');
      if(method==='sendPhoto'&&mode==='rejected')return Response.json({ok:false,error_code:400},{status:400});
      return Response.json({ok:true,result:{message_id:1}});
    },0,code=>logs.push(code));
    const message={...renderText(mode==='long'?'x'.repeat(1100):'Short story.')[0]!,imageUrl:mode==='invalid'?'http://localhost/x':'https://example.com/a.jpg'};
    if(mode==='uncertain')await assert.rejects(()=>api.sendMessage('12345',message));else await api.sendMessage('12345',message);
    assert.deepEqual(methods,mode==='rejected'?['sendPhoto','sendMessage']:mode==='long'||mode==='invalid'?['sendMessage']:['sendPhoto']);
    if(mode==='rejected')assert.ok(logs.includes('TELEGRAM_IMAGE_REJECTED_TEXT_FALLBACK'));
  }
});
test('stored cluster images reach safe captions; missing images and oversized stories stay text; Explain is concise',async()=>{
  const db=await localDatabase();try {
    const userId=await createUser(db.owner,'12345'),ranking=await seedDigestRankings(db,userId);
    const digest=(await generateDigest(db.runtime,digestFixtureModel,{userId,operationId:crypto.randomUUID(),rankingOperationIds:[ranking],periodStart:DIGEST_START,periodEnd:DIGEST_END},limits,{},now)).digest!;
    const messages=renderTelegramDigest(digest);
    assert.ok(messages.some(m=>m.imageUrl&&m.html.length<=1024));assert.ok(messages.some(m=>m.storyPosition&&!m.imageUrl));
    assert.ok(messages.some(m=>m.buttons?.some(row=>row.some(b=>b.text==='Read Source')&&row.some(b=>b.text==='Explain'))));
    const item=digest.sections.flatMap(s=>s.items).find(i=>i.sources.some(s=>s.imageUrl))!;item.summary='long '.repeat(1100);
    assert.ok(renderTelegramDigest(digest).every(m=>m.html.length<=4096));
    const model=telegramFixtureModel();
    const reply=await respondToNews(db.runtime,{userId,operationId:crypto.randomUUID(),action:{kind:'explain',digestId:digest.id,position:1}},{model,limits},now);
    assert.equal(reply.kind,'text');if(reply.kind==='text'){assert.match(reply.text,/Why this matters/);assert.ok(reply.text.split(/\s+/).length<100);}
  }finally{await db.close();}
});
test('visible command menu contains only start, news and preferences',async()=>{
  let commands:unknown;
  const api=new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz0123456789',async(_url,init)=>{commands=JSON.parse(String(init.body)).commands;return Response.json({ok:true,result:true});},0);
  await api.setCommands();assert.deepEqual((commands as {command:string}[]).map(c=>c.command),['start','news','latest','schedule','preferences','help']);
});
