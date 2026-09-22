import type { Database } from '../db/database.js';
import { DomainError, initialPreferences, telegramIdSchema } from '../domain/preferences.js';

export function authorizeTelegramUser(senderId: unknown, allowedIds: readonly string[]): string {
  const id = telegramIdSchema.safeParse(senderId);
  if (!id.success || !allowedIds.includes(id.data)) throw new DomainError('FORBIDDEN');
  return id.data;
}

// Bootstrap/onboarding service only. Never expose the migration-owner DB on a public route.
export async function createUser(ownerDb: Database, telegramId: string): Promise<string> {
  telegramIdSchema.parse(telegramId);
  return ownerDb.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO users (telegram_user_id) VALUES ($1)
       ON CONFLICT (telegram_user_id) DO UPDATE SET telegram_user_id = EXCLUDED.telegram_user_id
       RETURNING id`, [telegramId],
    );
    const id = rows[0]!.id;
    await tx.query(
      'INSERT INTO user_preferences (user_id, document) VALUES ($1, $2::jsonb) ON CONFLICT (user_id) DO NOTHING',
      [id, JSON.stringify(initialPreferences())],
    );
    return id;
  });
}
