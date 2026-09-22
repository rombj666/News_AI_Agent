import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { localDatabase } from '../scripts/local-db.js';
import { loadMigrations, migrate } from '../scripts/migrations.js';
import { asUser } from '../src/db/database.js';
import { createUser } from '../src/services/identity.js';
import { decideProposal, proposePreferences, readPreferences } from '../src/services/preferences.js';
import { createConversation, saveMessage, searchHistory } from '../src/services/history.js';
import { recordSharedUsage, recordUserUsage, userUsageSummary, type UsageEntry } from '../src/usage/ledger.js';

let db: Awaited<ReturnType<typeof localDatabase>>;
let alice: string;
let bob: string;
const now = new Date('2026-09-17T01:00:00Z');
const clock = { now: () => now };

before(async () => {
  db = await localDatabase();
  alice = await createUser(db.owner, '12345');
  bob = await createUser(db.owner, '67890');
});
after(async () => { await db?.close(); });

test('migrations are repeatable, checksum protected and atomic on failure', async () => {
  const migrations = await loadMigrations();
  assert.deepEqual(await migrate(db.owner, migrations), []);
  await assert.rejects(() => migrate(db.owner, [{ ...migrations[0]!, sql: migrations[0]!.sql + '\n-- changed' }]), /Applied migration changed/);
  await assert.rejects(() => migrate(db.owner, [{ name: '9999_broken.sql', sql: 'CREATE TABLE must_rollback(id int); SELECT missing_column;' }]));
  const result = await db.owner.query<{ relation: string | null }>("SELECT to_regclass('must_rollback')::text AS relation");
  assert.equal(result.rows[0]!.relation, null);
});

test('onboarding is repeatable and does not reset an existing profile', async () => {
  assert.equal(await createUser(db.owner, '12345'), alice);
  assert.notEqual(alice, bob);
  assert.equal((await readPreferences(db.runtime, bob)).document.deliveryEnabled, false);
});

test('RLS denies unscoped reads and writes and filters users even without a WHERE clause', async () => {
  assert.equal((await db.runtime.query('SELECT * FROM user_preferences')).rows.length, 0);
  const owned = await asUser(db.runtime, alice, (tx) => tx.query<{ user_id: string }>('SELECT user_id FROM user_preferences'));
  assert.deepEqual(owned.rows.map((row) => row.user_id), [alice]);
  const users = await asUser(db.runtime, alice, (tx) => tx.query<{ id: string }>('SELECT id FROM users'));
  assert.deepEqual(users.rows.map((row) => row.id), [alice]);
  assert.equal((await db.runtime.query('SELECT * FROM user_preferences')).rows.length, 0, 'transaction-local identity must not leak');
  await assert.rejects(() => asUser(db.runtime, alice, (tx) => tx.query('INSERT INTO conversations(user_id) VALUES ($1)', [bob])));
});

test('proposal cannot affect preferences before confirmation; cross-user, replay and stale changes fail', async () => {
  const initial = await readPreferences(db.runtime, alice);
  const proposal = await proposePreferences(db.runtime, alice, { ...initial.document, topics: { AI: 5 } }, clock);
  const stale = await proposePreferences(db.runtime, alice, { ...initial.document, topics: { Technology: 4 } }, clock);
  assert.deepEqual((await readPreferences(db.runtime, alice)).document, initial.document);
  await assert.rejects(() => decideProposal(db.runtime, bob, proposal.id, 'confirm', clock), /NOT_FOUND/);
  const confirmed = await decideProposal(db.runtime, alice, proposal.id, 'confirm', clock);
  assert.equal(confirmed.document.topics.AI, 5);
  assert.equal(confirmed.version, initial.version + 1);
  await assert.rejects(() => decideProposal(db.runtime, alice, proposal.id, 'confirm', clock), /NOT_PENDING/);
  await assert.rejects(() => decideProposal(db.runtime, alice, stale.id, 'confirm', clock), /STALE/);
  assert.equal((await readPreferences(db.runtime, alice)).version, confirmed.version);
  assert.deepEqual((await readPreferences(db.runtime, bob)).document.topics, {});
});

test('expired, cancelled, no-op and invalid proposals never modify profile', async () => {
  const current = await readPreferences(db.runtime, alice);
  const candidate = { ...current.document, language: 'zh' };
  const expired = await proposePreferences(db.runtime, alice, candidate, clock);
  await assert.rejects(() => decideProposal(db.runtime, alice, expired.id, 'confirm', {
    now: () => new Date(now.getTime() + 15 * 60_000),
  }), /EXPIRED/);
  const cancelled = await proposePreferences(db.runtime, alice, candidate, clock);
  await decideProposal(db.runtime, alice, cancelled.id, 'cancel', clock);
  await assert.rejects(() => decideProposal(db.runtime, alice, cancelled.id, 'confirm', clock), /NOT_PENDING/);
  await assert.rejects(() => proposePreferences(db.runtime, alice, current.document, clock), /NO_CHANGE/);
  await assert.rejects(() => proposePreferences(db.runtime, alice, { ...candidate, topics: { AI: 99 } }, clock));
  assert.deepEqual(await readPreferences(db.runtime, alice), current);
});

test('duplicate confirmations only apply once', async () => {
  const profile = await readPreferences(db.runtime, bob);
  const proposal = await proposePreferences(db.runtime, bob, { ...profile.document, writingStyle: 'concise' }, clock);
  const results = await Promise.allSettled([
    decideProposal(db.runtime, bob, proposal.id, 'confirm', clock),
    decideProposal(db.runtime, bob, proposal.id, 'confirm', clock),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await readPreferences(db.runtime, bob)).version, profile.version + 1);
});

test('old conversations remain searchable; ownership, dates, query values and result bounds are enforced', async () => {
  const conversation = await createConversation(db.runtime, alice);
  await saveMessage(db.runtime, alice, { conversationId: conversation, role: 'user', content: 'NVIDIA chips discussion in January', createdAt: new Date('2026-01-20') });
  await asUser(db.runtime, alice, (tx) => tx.query('UPDATE conversations SET archived_at = $2 WHERE id = $1', [conversation, now.toISOString()]));
  await assert.rejects(() => saveMessage(db.runtime, bob, { conversationId: conversation, role: 'user', content: 'foreign write', createdAt: now }));
  const history = await searchHistory(db.runtime, alice, { query: 'NVIDIA', since: new Date('2026-01-01'), until: new Date('2026-02-01') });
  assert.equal(history.length, 1);
  assert.match(history[0]!.content, /January/);
  assert.equal((await searchHistory(db.runtime, bob, { query: 'NVIDIA' })).length, 0);
  assert.equal((await searchHistory(db.runtime, alice, { query: 'NVIDIA', since: new Date('2026-09-01') })).length, 0);
  assert.equal((await searchHistory(db.runtime, alice, { query: "' OR 1=1 --" })).length, 0);
  await assert.rejects(() => searchHistory(db.runtime, alice, { query: 'NVIDIA', limit: 100 }));
  await assert.rejects(() => searchHistory(db.runtime, alice, { query: 'NVIDIA', since: now, until: new Date('2026-01-01') }));
});

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    operationId: randomUUID(), attempt: 1, provider: 'openai', model: 'gpt-5.6-luna', jobType: 'digest',
    requestId: null, status: 'succeeded', inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200,
    searchCalls: 0, estimatedCostNanodollars: 440_000n, rateSnapshot: { version: 'test' },
    executionTimeMs: 10, createdAt: now, ...overrides,
  };
}

test('usage preserves billable retries and unknown costs, deduplicates writes and separates shared/private totals', async () => {
  const first = entry();
  assert.equal(await recordUserUsage(db.runtime, alice, first), true);
  assert.equal(await recordUserUsage(db.runtime, alice, first), false);
  assert.equal(await recordUserUsage(db.runtime, alice, { ...first, attempt: 2, status: 'failed' }), true);
  await recordUserUsage(db.runtime, alice, entry({ status: 'unknown', inputTokens: null, cachedInputTokens: null, outputTokens: null, estimatedCostNanodollars: null }));
  await recordSharedUsage(db.owner, entry({ provider: 'brave', model: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, searchCalls: 1, estimatedCostNanodollars: 5_000_000n }));
  const summary = await userUsageSummary(db.runtime, alice, new Date('2026-09-01'), new Date('2026-10-01'));
  assert.deepEqual(summary, [{ provider: 'openai', knownCostNanodollars: 880_000n, attempts: 3, unknownCostAttempts: 1 }]);
  assert.deepEqual(await userUsageSummary(db.runtime, bob, new Date('2026-09-01'), new Date('2026-10-01')), []);
  const visible = await asUser(db.runtime, alice, (tx) => tx.query('SELECT * FROM ai_usage'));
  assert.equal(visible.rows.length, 3);
  await assert.rejects(() => recordSharedUsage(db.runtime, entry()));
  await assert.rejects(() => recordUserUsage(db.runtime, alice, entry({ inputTokens: null })));
});

test('scheduled occurrences have an owner-scoped uniqueness constraint', async () => {
  const sql = "INSERT INTO job_runs(user_id, job_type, occurrence_key) VALUES ($1, 'digest', '2026-09-17-07:00')";
  await asUser(db.runtime, alice, (tx) => tx.query(sql, [alice]));
  await assert.rejects(() => asUser(db.runtime, alice, (tx) => tx.query(sql, [alice])));
  await asUser(db.runtime, bob, (tx) => tx.query(sql, [bob]));
});
