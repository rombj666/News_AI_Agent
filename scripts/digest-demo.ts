import { localDatabase } from './local-db.js';
import { createUser } from '../src/services/identity.js';
import { generateDigest } from '../src/digest/service.js';
import { renderDigest } from '../src/digest/render.js';
import { DIGEST_NOW, DIGEST_START, DIGEST_END, digestTestLimits, digestFixtureModel, seedDigestRankings } from '../tests/fixtures/digest.js';

const db = await localDatabase();
try {
  const userId = await createUser(db.owner,'990001');
  const rankingId = await seedDigestRankings(db,userId);
  const result = await generateDigest(db.runtime,digestFixtureModel,{userId,operationId:crypto.randomUUID(),rankingOperationIds:[rankingId],
    periodStart:DIGEST_START,periodEnd:DIGEST_END},digestTestLimits,{},DIGEST_NOW);
  console.log('OFFLINE DIGEST DEMO: fictional stories and mock model; actual provider cost $0. Ledger telemetry is synthetic.');
  console.log(renderDigest(result.digest!));
  console.log(`Saved ${result.digest!.outputStoryCount} stories in an isolated in-memory database.`);
} finally { await db.close(); }
