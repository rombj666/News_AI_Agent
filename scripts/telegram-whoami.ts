import { telegramConfig } from '../src/adapters/telegram/config.js';
import { TelegramApi } from '../src/adapters/telegram/api.js';
import { pollTelegram } from '../src/adapters/telegram/polling.js';
import { telegramUpdateSchema } from '../src/adapters/telegram/types.js';
import { withTelegramLock, safeTelegramError } from './telegram-common.js';

async function main() {
  const config=telegramConfig(process.env,'whoami');
  await withTelegramLock(config.botId,async signal=>{
    const started=Math.floor(Date.now()/1000);
    console.log('Send /start to your bot in a private chat. This command prints the next matching sender; verify it is you.');
    await pollTelegram(new TelegramApi(config.token),async raw=>{
      const update=telegramUpdateSchema.safeParse(raw);
      const message=update.success?update.data.message:undefined;
      if(!message?.from||message.from.is_bot||message.chat.type!=='private'||message.chat.id!==message.from.id
        ||message.date<started||!/^\/start(?:\s|$)/i.test(message.text??''))return;
      console.log(JSON.stringify({telegram_user_id:String(message.from.id),chat_id:String(message.chat.id),
        ...(message.from.username?{username:message.from.username}:{})}));
      return true;
    },signal,console.log);
  });
}
main().catch(error=>{console.error(safeTelegramError(error));process.exitCode=1;});
