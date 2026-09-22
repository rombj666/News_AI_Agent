import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { localDatabase } from './local-db.js';
import { OpenAIResponses, ModelError } from '../src/ai/openai.js';
import { openaiLiveConfig, OpenAILiveConfigError } from '../src/ai/live-config.js';
import { refreshQuality } from '../src/quality/service.js';
import { rankStories } from '../src/ai/ranking.js';
import { asUser } from '../src/db/database.js';
async function main() {
  const config=openaiLiveConfig(process.env); // Fail before DB writes/network.
  const model=new OpenAIResponses(process.env);
  const path=fileURLToPath(new URL('../.local/retrieval-live-db',import.meta.url));
  await access(path);
  const db=await localDatabase(path);
  try {
    const now=new Date();
    const quality=await refreshQuality(db.quality,now);
    // One bounded request, at most three fresh clusters. No retrieval or invented fixtures.
    quality.candidates=quality.candidates.slice(0,3);
    if(!quality.candidates.length) throw new ModelError('NO_FRESH_CANDIDATES');
    const id=crypto.randomUUID();
    const result=await rankStories(db.runtime,model,config.userId,id,quality,config.limits,now);
    const usage=await asUser(db.runtime,config.userId,tx=>tx.query(`SELECT model,input_tokens,output_tokens,cached_input_tokens,
      estimated_cost_nanodollars::text,execution_time_ms,job_type,user_id,status FROM ai_usage WHERE operation_id=$1 AND user_id=$2`,[id,config.userId]));
    console.log(JSON.stringify({operationId:id,ranked:result.stories.length,usage:usage.rows[0]}));
    console.log('Ranking saved locally. No digest, search, Telegram, or scheduled work.');
  } finally {await db.close();}
}
main().catch(error=>{
  console.error(error instanceof OpenAILiveConfigError?error.message:error instanceof ModelError?error.code:'OPENAI_LOCAL_SETUP_OR_DATABASE_ERROR');
  process.exitCode=1;
});
