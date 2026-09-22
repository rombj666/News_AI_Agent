import { z } from 'zod';
import { asUser, type Database } from '../db/database.js';
import { uuidSchema } from '../domain/preferences.js';

export async function createConversation(db: Database, userId: string): Promise<string> {
  return asUser(db, userId, async (tx) => {
    const result = await tx.query<{ id: string }>('INSERT INTO conversations (user_id) VALUES ($1) RETURNING id', [userId]);
    return result.rows[0]!.id;
  });
}

const messageSchema = z.object({
  conversationId: uuidSchema,
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(20_000),
  createdAt: z.date().refine((date) => Number.isFinite(date.getTime())),
}).strict();

export async function saveMessage(db: Database, userId: string, input: z.infer<typeof messageSchema>) {
  const message = messageSchema.parse(input);
  return asUser(db, userId, async (tx) => {
    const result = await tx.query<{ id: string }>(
      'INSERT INTO messages (user_id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [userId, message.conversationId, message.role, message.content, message.createdAt.toISOString()],
    );
    return result.rows[0]!.id;
  });
}

const searchSchema = z.object({
  query: z.string().trim().min(1).max(250), limit: z.number().int().min(1).max(5).default(5),
  since: z.date().optional(), until: z.date().optional(),
}).refine((value) => !value.since || !value.until || value.since < value.until, 'Invalid date range');

export type HistoryMatch = { id: string; conversation_id: string; role: string; content: string; created_at: Date };

export async function searchHistory(db: Database, userId: string, input: z.input<typeof searchSchema>): Promise<HistoryMatch[]> {
  const search = searchSchema.parse(input);
  return asUser(db, userId, async (tx) => {
    const result = await tx.query<HistoryMatch>(
      `SELECT id, conversation_id, role, left(content, 2000) AS content, created_at
       FROM messages
       WHERE user_id = $1 AND search_document @@ websearch_to_tsquery('simple', $2)
       AND ($3::timestamptz IS NULL OR created_at >= $3)
       AND ($4::timestamptz IS NULL OR created_at < $4)
       ORDER BY ts_rank(search_document, websearch_to_tsquery('simple', $2)) DESC, created_at DESC, id
       LIMIT $5`,
      [userId, search.query, search.since?.toISOString() ?? null, search.until?.toISOString() ?? null, search.limit],
    );
    return result.rows;
  });
}
