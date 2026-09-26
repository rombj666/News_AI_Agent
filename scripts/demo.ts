import { randomUUID } from 'node:crypto';
import { localDatabase } from './local-db.js';
import { createUser } from '../src/services/identity.js';
import { decideProposal, proposePreferences, readPreferences } from '../src/services/preferences.js';
import { createConversation, saveMessage, searchHistory } from '../src/services/history.js';
import { recordUserUsage, userUsageSummary } from '../src/usage/ledger.js';
import { estimateLunaCost, formatUsd } from '../src/usage/pricing.js';

const db = await localDatabase();
try {
  const alice = await createUser(db.owner, '10001');
  const bob = await createUser(db.owner, '10002');
  const clock = { now: () => new Date('2026-09-17T01:00:00Z') };
  const before = await readPreferences(db.runtime, alice);
  const proposed = await proposePreferences(db.runtime, alice, { ...before.document, topics: { AI: 5 } }, clock);
  console.log('OFFLINE DEMO — fictional users, no API requests or messages sent.');
  console.log('Proposed AI priority 5. Saved priority before confirmation:', (await readPreferences(db.runtime, alice)).document.topics.AI ?? 'unset');
  const after = await decideProposal(db.runtime, alice, proposed.id, 'confirm', clock);
  console.log('After confirmation: AI priority', after.document.topics.AI, '| profile version', after.version);
  const conversation = await createConversation(db.runtime, alice);
  await saveMessage(db.runtime, alice, {
    conversationId: conversation, role: 'user', content: 'We discussed NVIDIA chips in January.',
    createdAt: new Date('2026-01-20T08:00:00Z'),
  });
  console.log('Old conversation matches for owner:', (await searchHistory(db.runtime, alice, { query: 'NVIDIA' })).length);
  console.log('Same search for the other user:', (await searchHistory(db.runtime, bob, { query: 'NVIDIA' })).length);
  const cost = estimateLunaCost({ inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200 });
  await recordUserUsage(db.runtime, alice, {
    operationId: randomUUID(), attempt: 1, provider: 'demo', model: 'gpt-5.6-luna', jobType: 'synthetic_digest',
    requestId: null, status: 'succeeded', inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200,
    searchCalls: 0, estimatedCostNanodollars: cost, rateSnapshot: { kind: 'synthetic_example_not_billed' },
    executionTimeMs: 0, createdAt: clock.now(),
  });
  const summary = await userUsageSummary(db.runtime, alice, new Date('2026-09-01'), new Date('2026-10-01'));
  console.log('Synthetic cost estimate (not actual spend):', formatUsd(summary[0]!.knownCostNanodollars));
console.log('Foundation demo completed. Live retrieval and Telegram use separate explicit commands.');
} finally {
  await db.close();
}
