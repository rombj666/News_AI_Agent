import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Database, Queryable } from '../src/db/database.js';
import { loadMigrations, migrate } from './migrations.js';

function queries(client: PGlite | Transaction): Queryable {
  return {
    query: <T>(sql: string, params?: unknown[]) => client.query<T>(sql, params),
    exec: (sql: string) => client.exec(sql),
  };
}

export async function localDatabase(dataDir?: string) {
  const engine = new PGlite(dataDir);
  await engine.waitReady;
  const owner: Database = {
    ...queries(engine),
    transaction: (work) => engine.transaction((tx) => work(queries(tx))),
  };
  try {
    await migrate(owner, await loadMigrations());
    // Test-only role; production provisioning must use a separate login/credential.
    await owner.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'news_runtime') THEN
          CREATE ROLE news_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'news_collector') THEN
          CREATE ROLE news_collector NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'news_quality') THEN
          CREATE ROLE news_quality NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO news_runtime;
      GRANT SELECT ON users TO news_runtime;
      GRANT SELECT, INSERT, UPDATE, DELETE ON user_preferences, pending_preference_changes,
        conversations, messages, ai_usage, job_runs TO news_runtime;
      GRANT SELECT ON articles, article_urls, sources, retrieval_runs, article_retrievals TO news_runtime;
      GRANT USAGE ON SCHEMA public TO news_collector;
      GRANT SELECT, INSERT, UPDATE ON sources, articles, article_urls, retrieval_runs, article_retrievals TO news_collector;
      GRANT SELECT, INSERT, UPDATE ON ai_usage TO news_collector;
      GRANT USAGE ON SCHEMA public TO news_quality;
      GRANT SELECT ON articles, article_urls TO news_quality;
      GRANT SELECT, INSERT ON quality_runs TO news_quality;
      GRANT SELECT, INSERT, UPDATE, DELETE ON story_clusters, article_cluster_members TO news_quality;
      GRANT SELECT ON story_clusters, article_cluster_members TO news_runtime;
    `);
    const runtime: Database = {
      query: <T>(sql: string, params?: unknown[]) => runtime.transaction((tx) => tx.query<T>(sql, params)),
      exec: (sql) => runtime.transaction((tx) => tx.exec(sql)),
      transaction: (work) => engine.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE news_runtime');
        return work(queries(tx));
      }),
    };
    const collector: Database = {
      query: <T>(sql: string, params?: unknown[]) => collector.transaction((tx) => tx.query<T>(sql, params)),
      exec: (sql) => collector.transaction((tx) => tx.exec(sql)),
      transaction: (work) => engine.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE news_collector');
        return work(queries(tx));
      }),
    };
    const quality: Database = {
      query: <T>(sql: string, params?: unknown[]) => quality.transaction((tx) => tx.query<T>(sql, params)),
      exec: (sql) => quality.transaction((tx) => tx.exec(sql)),
      transaction: (work) => engine.transaction(async (tx) => {
        await tx.exec('SET LOCAL ROLE news_quality');
        return work(queries(tx));
      }),
    };
    return { owner, runtime, collector, quality, close: () => engine.close() };
  } catch (error) {
    await engine.close();
    throw error;
  }
}
