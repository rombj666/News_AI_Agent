import { z } from 'zod';
import { abortableDelay } from './api.js';
import { TelegramError, type TelegramPolling } from './types.js';
import { safeFailure } from './diagnostics.js';

// Command-menu setup is idempotent and optional; never apply this retry to sends.
export async function setupTelegramCommands(transport:{setCommands(signal?:AbortSignal):Promise<void>},signal:AbortSignal,
  log:(code:string)=>void=()=>{},wait=abortableDelay):Promise<void> {
  for(let attempt=1;attempt<=3&&!signal.aborted;attempt++) {
    try {await transport.setCommands(signal);return;}
    catch(error) {
      if(signal.aborted)return;
      if(!(error instanceof TelegramError)||(/_4\d\d$/.test(error.code)&&!/_429$/.test(error.code)))throw error;
      // Do not retry before a long server-requested cooldown; menu setup is optional.
      if(attempt===3||(error.retryAfterMs??0)>15000){log(`TELEGRAM_MENU_SETUP_DEFERRED: ${safeFailure(error)}`);return;}
      const delay=Math.min(15000,Math.max(1000*2**(attempt-1),error.retryAfterMs??0));
      log(`TELEGRAM_MENU_RECONNECT: ${safeFailure(error)} attempt=${attempt} retry_ms=${delay}`);
      try {await wait(delay,signal);}catch(error){if(!signal.aborted)throw error;return;}
    }
  }
}

export async function pollTelegram(transport:TelegramPolling,handle:(update:unknown)=>Promise<boolean|void>,signal:AbortSignal,
  log:(code:string)=>void=()=>{},wait=abortableDelay):Promise<void> {
  let offset=0,failures=0;
  while(!signal.aborted) {
    let updates:unknown[];
    try {updates=await transport.getUpdates(offset,signal);if(failures)log(`TELEGRAM_POLL_RECOVERED: consecutive_failures=${failures}`);failures=0;}
    catch(error) {
      if(signal.aborted) return;
      if(error instanceof TelegramError && /_4\d\d$/.test(error.code) && !/_429$/.test(error.code)) {log(`TELEGRAM_POLL_FATAL: ${safeFailure(error)}`);throw error;}
      failures++;
      const delay=error instanceof TelegramError&&/_429$/.test(error.code)?Math.max(1000,error.retryAfterMs??30000):Math.min(15000,1000*2**Math.min(failures-1,4));
      log(`TELEGRAM_POLL_RECONNECT: ${safeFailure(error)} consecutive_failures=${failures} retry_ms=${delay}`);
      try {await wait(delay,signal);}catch {if(signal.aborted)return;throw new TelegramError('TELEGRAM_POLL_FAILED');}
      continue;
    }
    for(const update of updates) {
      const id=z.object({update_id:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1)}).safeParse(update);
      if(!id.success) throw new TelegramError('TELEGRAM_UPDATE_ID_INVALID');
      if(id.data.update_id<offset) continue;
      // Do not advance the offset if application persistence throws.
      const stop=await handle(update);
      offset=id.data.update_id+1;
      if(stop||signal.aborted) return;
    }
  }
}
