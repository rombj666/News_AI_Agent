import { neonDatabase, type DatabaseRole } from './src/db/neon.ts';

const target = process.argv[2];

const configs: Record<string, {
  env: string;
  role: DatabaseRole;
  table: string;
}> = {
  runtime: {
    env: 'DATABASE_URL',
    role: 'news_runtime',
    table: 'users'
  },
  collector: {
    env: 'COLLECTOR_DATABASE_URL',
    role: 'news_collector',
    table: 'scheduled_collection_batches'
  },
  quality: {
    env: 'QUALITY_DATABASE_URL',
    role: 'news_quality',
    table: 'quality_runs'
  }
};

const config = configs[target];

if (!config) {
  throw new Error('Use runtime, collector, or quality');
}

const url = process.env[config.env];

if (!url) {
  throw new Error(`Missing ${config.env}`);
}

const { db, close } = neonDatabase(url, config.role);

try {
  const result = await db.query(
    `SELECT
       current_user AS role,
       has_table_privilege(
         current_user,
         $1,
         'SELECT'
       ) AS select_ok`,
    [`public.${config.table}`]
  );

  console.log(target.toUpperCase(), 'PASS');
  console.log(result.rows);
} catch (error) {
  console.log(target.toUpperCase(), 'FAIL');
  console.log(error instanceof Error ? error.message : 'UNKNOWN_ERROR');
} finally {
  try {
    await close();
  } catch (error) {
    console.log(
      target.toUpperCase(),
      'CLOSE_FAIL',
      error instanceof Error ? error.message : 'UNKNOWN_ERROR'
    );
  }
}
