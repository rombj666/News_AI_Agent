import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localDatabase } from '../scripts/local-db.js';
import { createUser } from '../src/services/identity.js';
import { existingTelegramUser, generateTelegramDigest } from '../src/services/telegram-digest.js';
import { asUser } from '../src/db/database.js';
import { DIGEST_NOW, digestTestLimits, digestFixtureModel, seedDigestRankings } from './fixtures/digest.js';

test('Telegram digest resolves an existing allowed identity without creating users; rejects ambiguous, foreign and missing identities',async()=>{
  const db=await localDatabase();
  try {
    const id=await createUser(db.owner,'12345');
    assert.deepEqual(await existingTelegramUser(db.owner,['12345']),{telegramId:'12345',userId:id});
    await assert.rejects(()=>existingTelegramUser(db.owner,['12345','67890']));
    await assert.rejects(()=>existingTelegramUser(db.owner,['12345'],'99999'));
    await assert.rejects(()=>existingTelegramUser(db.owner,['67890']));
    assert.equal((await db.owner.query('SELECT id FROM users')).rows.length,1);
  } finally {await db.close();}
});

test('manual Telegram digest reuses owned rankings, persists NORMAL for the same user and replays without billing',async()=>{
  const db=await localDatabase();
  try {
    const userId=await createUser(db.owner,'12345');
    await seedDigestRankings(db,userId);
    let calls=0;
    const model={...digestFixtureModel,generate:async(request:Parameters<typeof digestFixtureModel.generate>[0])=>{
      calls++;return digestFixtureModel.generate(request);
    }};
    const first=await generateTelegramDigest(db.runtime,db.quality,model,userId,digestTestLimits,DIGEST_NOW);
    assert.equal(first.digest?.userId,userId);assert.equal(first.digest?.type,'normal');assert.equal(calls,1);
    const second=await generateTelegramDigest(db.runtime,db.quality,model,userId,digestTestLimits,DIGEST_NOW);
    assert.equal(second.digest?.id,first.digest?.id);assert.equal(second.replayed,true);assert.equal(calls,1);
    const other=await createUser(db.owner,'67890');
    assert.equal((await asUser(db.runtime,other,tx=>tx.query('SELECT id FROM digests'))).rows.length,0);
  } finally {await db.close();}
});

test('empty stored pool stops before any model call or usage entry',async()=>{
  const db=await localDatabase();
  try {
    const userId=await createUser(db.owner,'12345');
    await assert.rejects(()=>generateTelegramDigest(db.runtime,db.quality,{...digestFixtureModel,generate:async()=>{
      assert.fail('must not call AI');
    }},userId,digestTestLimits,DIGEST_NOW),/NO_FRESH_CANDIDATES/);
    assert.equal((await db.owner.query('SELECT id FROM ai_usage')).rows.length,0);
  } finally {await db.close();}
});

test('foreign rankings are not reused; missing owned ranking produces one metered ranking and digest',async()=>{
  const db=await localDatabase();
  try {
    await seedDigestRankings(db,await createUser(db.owner,'67890'));
    const userId=await createUser(db.owner,'12345');
    let calls=0;
    const model={...digestFixtureModel,generate:async(request:Parameters<typeof digestFixtureModel.generate>[0])=>{
      calls++;
      const input=JSON.parse(request.context);
      if(input.stories[0].sources) return digestFixtureModel.generate(request);
      return {text:JSON.stringify({stories:input.stories.map((s:{clusterId:string})=>({clusterId:s.clusterId,
        primaryCategory:'world',secondaryCategories:[],region:'World',countries:[],importanceScore:60,userRelevanceScore:50,
        confidence:0.8,importanceReason:'Stored news.',entities:[],topics:[]}))}),
        usage:{inputTokens:100,cachedInputTokens:0,outputTokens:80},requestId:'resp_offline'};
    }};
    const result=await generateTelegramDigest(db.runtime,db.quality,model,userId,digestTestLimits,DIGEST_NOW);
    assert.equal(calls,2);assert.equal(result.digest?.userId,userId);
    const usage=await asUser(db.runtime,userId,tx=>tx.query<{job_type:string}>('SELECT job_type FROM ai_usage'));
    assert.deepEqual(usage.rows.map(r=>r.job_type).sort(),['news_digest','news_ranking']);
  } finally {await db.close();}
});
