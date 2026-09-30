import { pathToFileURL } from 'node:url';
import { TelegramApi } from '../src/adapters/telegram/api.js';
import type { Fetcher } from '../src/retrieval/http.js';

export async function setTelegramCommands(env:Record<string,string|undefined>,fetcher?:Fetcher,log:(text:string)=>void=console.log) {
  const api=new TelegramApi(env.TELEGRAM_BOT_TOKEN??'',fetcher);
  await api.setCommands();
  log('TELEGRAM_COMMANDS_UPDATED');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  setTelegramCommands(process.env).catch(()=>{console.error('TELEGRAM_COMMANDS_UPDATE_FAILED');process.exitCode=1;});
}
