import { telegramConfig } from '../src/adapters/telegram/config.js';
import { TelegramApi } from '../src/adapters/telegram/api.js';
import { renderText } from '../src/adapters/telegram/render.js';
import { withTelegramLock, safeTelegramError } from './telegram-common.js';

async function main() {
  const config=telegramConfig(process.env,'test');
  await withTelegramLock(config.botId,async signal=>{
    await new TelegramApi(config.token).sendMessage(config.targetId!,renderText('News AI Agent connectivity test. Telegram is connected. No AI or search was used.')[0]!,signal);
    console.log('TELEGRAM_CONNECTIVITY_TEST_SENT');
  });
}
main().catch(error=>{console.error(safeTelegramError(error));process.exitCode=1;});
