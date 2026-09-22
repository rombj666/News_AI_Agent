import { uuidSchema } from '../domain/preferences.js';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}

export interface Database extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
}

export function asUser<T>(db: Database, userId: string, work: (tx: Queryable) => Promise<T>): Promise<T> {
  uuidSchema.parse(userId);
  return db.transaction(async (tx) => {
    // Transaction-local state prevents pooled connections leaking a previous user's scope.
    await tx.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    return work(tx);
  });
}
