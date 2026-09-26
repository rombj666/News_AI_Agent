import { schedulerFixture,SCHEDULE_NOW } from '../tests/fixtures/scheduler.js';
import { runScheduledPipeline } from '../src/scheduling/pipeline.js';
import { asUser } from '../src/db/database.js';
const f=await schedulerFixture();
try {
  console.log('OFFLINE SCHEDULER DEMO: fake clock 07:00 Asia/Kuala_Lumpur; mocked RSS, Luna and Telegram; actual provider cost $0.');
  const result=await runScheduledPipeline(f.deps,f.userId,f.telegramId,SCHEDULE_NOW);
  const rows=await asUser(f.db.runtime,f.userId,tx=>tx.query('SELECT local_date,scheduled_for,candidate_count,ranking_status,digest_id,delivery_status,status FROM scheduled_pipeline_runs'));
  console.log(JSON.stringify({result,stages:rows.rows,providerCalls:f.counts,telegramMessages:f.transport.sent.length}));
  console.log(JSON.stringify({restart:await runScheduledPipeline(f.deps,f.userId,f.telegramId,SCHEDULE_NOW),providerCalls:f.counts}));
  if(result.status!=='completed') throw new Error('DEMO_FAILED');
} finally {await f.db.close();}
