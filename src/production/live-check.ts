import { ModelError } from '../ai/openai.js';
import { RetrievalError } from '../retrieval/http.js';
import { TelegramError } from '../adapters/telegram/types.js';
export function liveCheckCode(error:unknown) {
  if((error instanceof ModelError||error instanceof RetrievalError||error instanceof TelegramError)&&/^[A-Z0-9_]{1,80}$/.test(error.code))return error.code;
  return 'INTEGRATION_OR_DATABASE_ERROR';
}
export async function runLiveChecks(flag:string|undefined,checks:ReadonlyArray<{name:string;run:()=>Promise<unknown>}>,log:(line:string)=>void) {
  if(flag!=='YES')throw new ModelError('RUN_LIVE_PRODUCTION_CHECK_REQUIRED');
  let passed=true;
  for(const check of checks) {
    try{await check.run();log(`${check.name} PASS`);}
    catch(error){passed=false;log(`${check.name} FAIL ${liveCheckCode(error)}`);}
  }
  return passed;
}
