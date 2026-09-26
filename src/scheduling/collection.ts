import type { Database } from '../db/database.js';
import { systemClock,type Clock,type NewsRetriever } from '../domain/ports.js';
import { collectNews, type CollectionLimits, type CollectionRequest } from '../retrieval/collect.js';
import { requestHash } from '../ai/metered.js';

export type CollectionSource={retriever:NewsRetriever;request:Omit<CollectionRequest,'runId'|'since'|'userId'>;limits?:CollectionLimits};
export type CollectionSummary={provider:string;status:string;runId?:string;failureCode?:string;fetched?:number};
export async function sharedCollection(db:Database,sources:CollectionSource[],now:Date,signal?:AbortSignal,clock:Clock=systemClock):Promise<CollectionSummary[]> {
  const hour=new Date(Math.floor(+now/3600000)*3600000);
  const key=await requestHash({hour:hour.toISOString(),sources:sources.map(s=>({provider:s.retriever.provider,request:s.request}))});
  const claim=await db.transaction(async tx=>{
    const inserted=await tx.query<{id:string}>('INSERT INTO scheduled_collection_batches(batch_key,started_at,status) VALUES($1,$2,\'running\') ON CONFLICT DO NOTHING RETURNING id',[key,now.toISOString()]);
    if(inserted.rows[0]) return {id:inserted.rows[0].id,results:null};
    const prior=(await tx.query<{results:CollectionSummary[];status:string}>('SELECT results,status FROM scheduled_collection_batches WHERE batch_key=$1',[key])).rows[0]!;
    return {id:null,results:prior.status==='running'?[{provider:'shared',status:'running',failureCode:'COLLECTION_IN_PROGRESS'}]:prior.results};
  });
  if(claim.results) return claim.results;
  const results:CollectionSummary[]=[];
  for(const source of sources) {
    if(signal?.aborted) {results.push({provider:source.retriever.provider,status:'failed',failureCode:'STOPPED'});break;}
    try {
      const result=await collectNews(db,source.retriever,{...source.request,runId:crypto.randomUUID(),since:new Date(+hour-86400000)},
        {...(source.limits?{limits:source.limits}:{}),clock,...(signal?{signal}:{})});
      results.push({provider:source.retriever.provider,status:result.status,runId:result.id,fetched:result.number_fetched});
    } catch {results.push({provider:source.retriever.provider,status:'failed',failureCode:'COLLECTION_FAILED_OR_BUDGET_REJECTED'});}
  }
  await db.query('UPDATE scheduled_collection_batches SET results=$2::jsonb,status=\'completed\',completed_at=$3 WHERE id=$1',
    [claim.id,JSON.stringify(results),clock.now().toISOString()]);
  return results;
}
