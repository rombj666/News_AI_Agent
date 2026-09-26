import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localDatabase } from '../scripts/local-db.js';
import { createUser } from '../src/services/identity.js';
import { generateTelegramDigest } from '../src/services/telegram-digest.js';
import { DIGEST_NOW as now,digestTestLimits as limits,digestFixtureModel,seedDigestRankings } from './fixtures/digest.js';
import { RssRetriever } from '../src/retrieval/rss.js';
import { normalizeArticle } from '../src/retrieval/normalize.js';
import { persistArticle } from '../src/retrieval/repository.js';
import { renderTelegramDigest } from '../src/adapters/telegram/render.js';
import { TelegramApi } from '../src/adapters/telegram/api.js';
import { TelegramError } from '../src/adapters/telegram/types.js';
import { setupTelegramCommands } from '../src/adapters/telegram/polling.js';

test('BBC-style RSS thumbnails enrich duplicates; forced metered digest carries images into photo captions/buttons',async()=>{
  const db=await localDatabase();
  try {
    const userId=await createUser(db.owner,'12345');await seedDigestRankings(db,userId);
    await db.owner.query('UPDATE articles SET image_url=NULL');
    let calls=0;
    const model={...digestFixtureModel,generate:async(request:Parameters<typeof digestFixtureModel.generate>[0])=>{calls++;return digestFixtureModel.generate(request);}};
    const first=await generateTelegramDigest(db.runtime,db.quality,model,userId,limits,now);
    assert.ok(renderTelegramDigest(first.digest!).every(m=>!m.imageUrl));
    const source={id:'fixture',name:'Fictional News',url:'https://example.com/rss',enabled:true,category:'technology'};
    const xml='<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item><title>Orbital lab publishes open telescope software</title><link>https://example.com/digest/0</link><pubDate>Wed, 23 Sep 2026 08:00:00 GMT</pubDate><media:thumbnail width="240" height="135" url="https://ichef.bbci.co.uk/ace/standard/240/example.jpg" /></item></channel></rss>';
    const rss=new RssRetriever(source,async()=>new Response(xml),{now:()=>now});
    const batch=await rss.collect({query:'',since:new Date(+now-86400000),limit:10,signal:new AbortController().signal});
    assert.equal(batch.items[0]!.imageUrl,'https://ichef.bbci.co.uk/ace/standard/240/example.jpg');
    const article=await normalizeArticle(batch.items[0]!);
    const persisted=await db.collector.transaction(tx=>persistArticle(tx,article));assert.equal(persisted.duplicate,true);
    for(const imageUrl of [null,'https://example.com/replacement.jpg']) {
      const again=await db.collector.transaction(tx=>persistArticle(tx,{...article,imageUrl}));assert.equal(again.id,persisted.id);
    }
    assert.equal((await db.owner.query<{image_url:string}>('SELECT image_url FROM articles WHERE id=$1',[persisted.id])).rows[0]!.image_url,article.imageUrl);
    assert.equal((await db.owner.query('SELECT id FROM articles')).rows.length,4);
    const replay=await generateTelegramDigest(db.runtime,db.quality,model,userId,limits,now);
    assert.equal(replay.digest!.id,first.digest!.id);assert.equal(calls,1);
    const forced=await generateTelegramDigest(db.runtime,db.quality,model,userId,limits,now,{force:true});
    assert.notEqual(forced.digest!.id,first.digest!.id);assert.equal(forced.digest!.userId,userId);assert.equal(calls,2);
    assert.equal((await db.owner.query("SELECT id FROM ai_usage WHERE job_type='news_digest' AND status='succeeded'")).rows.length,2);
    assert.equal((await db.owner.query('SELECT id FROM users')).rows.length,1);
    const messages=renderTelegramDigest(forced.digest!);assert.equal(messages.filter(m=>m.imageUrl).length,1);
    const payloads:{method:string;body:Record<string,unknown>}[]=[];
    const api=new TelegramApi('123456:abcdefghijklmnopqrstuvwxyz0123456789',async(url,init)=>{
      payloads.push({method:url.split('/').at(-1)!,body:JSON.parse(String(init.body))});
      return Response.json({ok:true,result:{message_id:payloads.length}});
    },0);
    for(const message of messages)await api.sendMessage('12345',message);
    const photo=payloads.find(p=>p.method==='sendPhoto')!;
    assert.equal(photo.body.photo,article.imageUrl);assert.ok(String(photo.body.caption).length<=1024);assert.ok(photo.body.reply_markup);
    assert.ok(payloads.some(p=>p.method==='sendMessage'));
  }finally{await db.close();}
});

test('extensionless grouped media thumbnails are accepted while unsafe thumbnails are ignored',async()=>{
  const rss=new RssRetriever({id:'fixture',name:'Fixture',url:'https://example.com/rss',enabled:true,category:'world'},async()=>new Response(
    '<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item><title>News</title><link>https://example.com/story</link><media:thumbnail url="https://localhost/image"/><media:group><media:thumbnail url="https://example.com/image/123" /></media:group></item></channel></rss>'));
  const batch=await rss.collect({query:'',since:now,limit:10,signal:new AbortController().signal});
  assert.equal(batch.items[0]!.imageUrl,'https://example.com/image/123');
});

test('menu startup recovers temporary resets, defers after bounded attempts, and never hides authentication failures',async()=>{
  for(const recover of [true,false]) {
    let calls=0;const logs:string[]=[],delays:number[]=[];
    await setupTelegramCommands({setCommands:async()=>{calls++;if(!recover||calls<3)throw new TelegramError('TELEGRAM_NETWORK_OR_RESPONSE_ERROR',null,'CONNECTION_RESET');}},
      new AbortController().signal,s=>logs.push(s),async ms=>{delays.push(ms);});
    assert.equal(calls,3);assert.deepEqual(delays,[1000,2000]);
    assert.equal(logs.some(s=>s.includes('SETUP_DEFERRED')),!recover);
    assert.ok(logs[0]?.includes('CONNECTION_RESET'));
  }
  let calls=0;
  await assert.rejects(()=>setupTelegramCommands({setCommands:async()=>{calls++;throw new TelegramError('TELEGRAM_API_401');}},new AbortController().signal));
  assert.equal(calls,1);
  calls=0;
  await setupTelegramCommands({setCommands:async()=>{calls++;throw new TelegramError('TELEGRAM_API_429',60000);}},new AbortController().signal,
    ()=>{},async()=>assert.fail('must defer rather than violate server cooldown'));
  assert.equal(calls,1);
});
