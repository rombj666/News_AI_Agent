import type { Database, Queryable } from '../db/database.js';
import { asUser } from '../db/database.js';
import { DomainError, preferencesSchema, uuidSchema, type Preferences } from '../domain/preferences.js';
import { systemClock, type Clock } from '../domain/ports.js';

type ProfileRow = { document: Preferences; version: number };
type ProposalRow = {
  id: string; old_value: Preferences; new_value: Preferences;
  expected_version: number; status: string; expires_at: Date;
};

async function profile(tx: Queryable, userId: string, lock = false): Promise<ProfileRow> {
  const result = await tx.query<ProfileRow>(
    `SELECT document, version FROM user_preferences WHERE user_id = $1${lock ? ' FOR UPDATE' : ''}`, [userId],
  );
  if (!result.rows[0]) throw new DomainError('NOT_FOUND');
  return result.rows[0];
}

export function readPreferences(db: Database, userId: string) {
  return asUser(db, userId, (tx) => profile(tx, userId));
}

export async function proposePreferences(
  db: Database, userId: string, proposed: unknown, clock: Clock = systemClock, expectedVersion?: number,
) {
  const validated = preferencesSchema.parse(proposed);
  const now = clock.now();
  return asUser(db, userId, async (tx) => {
    const current = await profile(tx, userId, true);
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new DomainError('STALE');
    const { rows } = await tx.query<ProposalRow>(
      `INSERT INTO pending_preference_changes
        (user_id, old_value, new_value, expected_version, created_at, expires_at)
       SELECT $1, $2::jsonb, $3::jsonb, $4, $5, $6
       WHERE $2::jsonb <> $3::jsonb
       RETURNING id, old_value, new_value, expected_version, status, expires_at`,
      [userId, JSON.stringify(current.document), JSON.stringify(validated), current.version,
        now.toISOString(), new Date(now.getTime() + 15 * 60_000).toISOString()],
    );
    if (!rows[0]) throw new DomainError('NO_CHANGE');
    return rows[0];
  });
}

export async function decideProposal(
  db: Database, userId: string, proposalId: string, decision: 'confirm' | 'cancel', clock: Clock = systemClock,
): Promise<ProfileRow> {
  uuidSchema.parse(proposalId);
  if (decision !== 'confirm' && decision !== 'cancel') throw new Error('Invalid decision');
  return asUser(db, userId, async (tx) => {
    const { rows } = await tx.query<ProposalRow>(
      `SELECT id, old_value, new_value, expected_version, status, expires_at
       FROM pending_preference_changes WHERE user_id = $1 AND id = $2 FOR UPDATE`, [userId, proposalId],
    );
    const proposal = rows[0];
    if (!proposal) throw new DomainError('NOT_FOUND');
    if (proposal.status !== 'pending') throw new DomainError('NOT_PENDING');
    const now = clock.now();
    if (new Date(proposal.expires_at).getTime() <= now.getTime()) throw new DomainError('EXPIRED');
    const current = await profile(tx, userId, true);
    if (decision === 'confirm') {
      if (current.version !== proposal.expected_version) throw new DomainError('STALE');
      const document = preferencesSchema.parse(proposal.new_value);
      await tx.query(
        'UPDATE user_preferences SET document = $2::jsonb, version = version + 1, updated_at = $3 WHERE user_id = $1',
        [userId, JSON.stringify(document), now.toISOString()],
      );
    }
    await tx.query(
      `UPDATE pending_preference_changes SET status = $3, decided_at = $4
       WHERE user_id = $1 AND id = $2`,
      [userId, proposalId, decision === 'confirm' ? 'confirmed' : 'cancelled', now.toISOString()],
    );
    return profile(tx, userId);
  });
}
