import { TelegramApi } from '../adapters/telegram/api.js';
import type { TelegramUpdate } from '../adapters/telegram/types.js';
import type { productionConfig } from './config.js';
import type { Fetcher } from '../retrieval/http.js';

// Transport status only: no conversation writes and no automatic retries after
// an uncertain send. The caller must first win the durable inbox insert.
export async function acknowledgeNewsUpdate(config:ReturnType<typeof productionConfig>,update:TelegramUpdate,
  fetcher:Fetcher=(url,init)=>globalThis.fetch(url,init)) {
  const transport=new TelegramApi(config.telegram.token,fetcher);
  if(update.callback_query)await transport.answerCallback(update.callback_query.id,'Searching for fresh news…');
  else if(update.message)await transport.sendMessage(String(update.message.chat.id),{
    html:'🔎 Searching for fresh news now. This may take a moment.',
    plain:'🔎 Searching for fresh news now. This may take a moment.',
  });
}
