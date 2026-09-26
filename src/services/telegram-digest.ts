import { asUser, type Database } from '../db/database.js';
import { authorizeTelegramUser } from './identity.js';
import { ModelError } from '../ai/openai.js';
import { rankStories,fitRankingCandidates } from '../ai/ranking.js';
import { type ModelLimits } from '../ai/metered.js';
import { refreshQuality } from '../quality/service.js';
import { generateDigest } from '../digest/service.js';
import { loadRankedStories } from '../digest/ranked-stories.js';
import { selectDigestStories } from '../digest/selection.js';
import { readPreferences } from './preferences.js';
import type { LanguageModel } from '../domain/ports.js';
import type { Digest } from '../digest/types.js';

export async function existingTelegramUser(db:Database,allowedIds:string[],target?:string) {
  const telegramId=target || (allowedIds.length===1?allowedIds[0]:undefined);
  if(!telegramId) throw new ModelError('SELECT_LIVE_TELEGRAM_USER_ID');
  authorizeTelegramUser(telegramId,allowedIds);
  const row=(await db.query<{id:string}>("SELECT id FROM users WHERE telegram_user_id=$1 AND status='active'",[telegramId])).rows[0];
  if(!row) throw new ModelError('TELEGRAM_LINKED_USER_NOT_FOUND');
  return {telegramId,userId:row.id};
}

// Explicit local invocation only. No identity creation, retrieval, or delivery.
export async function generateTelegramDigest(db:Database,qualityDb:Database,model:LanguageModel,userId:string,limits:ModelLimits,now=new Date(),options:{force?:boolean}={}) {
  const today=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
  const prior=await asUser(db,userId,async tx=>(await tx.query<{status:string;document:Digest|null}>(
    "SELECT status,document FROM digests WHERE user_id=$1 AND digest_type='normal' AND created_at >= $2 ORDER BY created_at DESC LIMIT 1",
    [userId,today.toISOString()])).rows[0]);
  if(prior?.status==='succeeded'&&!options.force) return {digest:prior.document!,replayed:true};
  if(prior&&(!options.force||prior.status==='running')) throw new ModelError('DIGEST_ALREADY_ATTEMPTED');
  const periodStart=new Date(+now-86400000),periodEnd=now;
  const quality=await refreshQuality(qualityDb,now);
  if(!quality.candidates.length) throw new ModelError('NO_FRESH_CANDIDATES_REFRESH_RSS_SEPARATELY');
  const profile=await readPreferences(db,userId);
  let ids=await asUser(db,userId,async tx=>(await tx.query<{id:string}>(
    "SELECT id FROM job_runs WHERE user_id=$1 AND job_type='news_ranking' AND status='succeeded' ORDER BY updated_at DESC LIMIT 10",[userId])).rows.map(r=>r.id));
  const ranked=await loadRankedStories(db,userId,ids,now,periodStart,periodEnd);
  if(!selectDigestStories(ranked,profile.document,'normal').length) {
    quality.candidates=fitRankingCandidates(quality.candidates,profile.document,limits);
    const id=crypto.randomUUID();
    await rankStories(db,model,userId,id,quality,limits,now);
    ids=[id];
  }
  return generateDigest(db,model,{userId,operationId:crypto.randomUUID(),rankingOperationIds:ids,periodStart,periodEnd,type:'normal',force:options.force??false},limits,{},now);
}
