import { mkdir, open, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TelegramConfigError } from '../src/adapters/telegram/config.js';
import { TelegramError } from '../src/adapters/telegram/types.js';
import { safeFailure } from '../src/adapters/telegram/diagnostics.js';

export function safeTelegramError(error:unknown):string {
  if(error instanceof TelegramConfigError) return error.message;
  if(error instanceof TelegramError && /^TELEGRAM_[A-Z0-9_]{1,60}$/.test(error.code)) return safeFailure(error);
  return 'TELEGRAM_LOCAL_SETUP_OR_DATABASE_ERROR';
}
export async function withTelegramLock(botId:string,work:(signal:AbortSignal)=>Promise<void>):Promise<void> {
  const directory=new URL('../.local/',import.meta.url);await mkdir(directory,{recursive:true});
  const path=fileURLToPath(new URL(`telegram-${botId}.lock`,directory));
  const handle=await open(path,'wx').catch(()=>{throw new TelegramError('TELEGRAM_LOCAL_PROCESS_LOCKED');});
  const controller=new AbortController();
  const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {await work(controller.signal);}
  finally {process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await handle.close();await unlink(path);}
}
