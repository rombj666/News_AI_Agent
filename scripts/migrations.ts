import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { Database } from '../src/db/database.js';

export type Migration = { name: string; sql: string };

export async function loadMigrations(): Promise<Migration[]> {
  const directory = new URL('../migrations/', import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d{4}_[a-z_]+\.sql$/.test(name)).sort();
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(new URL(name, directory), 'utf8') })));
}

export async function migrate(db: Database, migrations: Migration[]): Promise<string[]> {
  return db.transaction(async (tx) => {
    // Serializes migration runners without a session-scoped lock leaking in pools.
    await tx.query('SELECT pg_advisory_xact_lock(74102918)');
    await tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied: string[] = [];
    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const existing = await tx.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name = $1', [migration.name]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${migration.name}`);
        continue;
      }
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [migration.name, checksum]);
      applied.push(migration.name);
    }
    return applied;
  });
}
