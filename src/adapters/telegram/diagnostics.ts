import { TelegramError } from './types.js';
import { DomainError } from '../../domain/preferences.js';
import { ModelError } from '../../ai/openai.js';

// Match known descriptions only; never log interpolated Telegram prose or URLs.
export function telegramReason(description:unknown,status:number):string {
  const d=typeof description==='string'?description.toLowerCase():'';
  if(/caption.*too long/.test(d))return 'CAPTION_TOO_LONG';
  if(/message.*too long/.test(d))return 'MESSAGE_TOO_LONG';
  if(/parse entities|unsupported start tag|end tag|entity.*byte offset/.test(d))return 'HTML_INVALID';
  if(/button_data_invalid|callback data/.test(d))return 'CALLBACK_DATA_INVALID';
  if(/button.*url|url.*invalid|wrong http url/.test(d))return 'URL_INVALID';
  if(/reply markup|inline keyboard|keyboard.*invalid/.test(d))return 'KEYBOARD_INVALID';
  if(/wrong type of the web page|image_process_failed|photo.*invalid|photo_invalid|file.*type/.test(d))return 'PHOTO_FORMAT_INVALID';
  if(/failed to get http url content|wrong file identifier|webpage_curl_failed|file.*not found/.test(d))return 'PHOTO_FETCH_FAILED';
  if(/photo.*size|file.*too big|request entity too large/.test(d))return 'PHOTO_TOO_LARGE';
  if(/chat not found/.test(d))return 'CHAT_NOT_FOUND';
  if(/blocked by the user/.test(d))return 'BOT_BLOCKED';
  if(/webhook/.test(d)&&status===409)return 'WEBHOOK_CONFLICT';
  if(status===409)return 'POLLING_CONFLICT';
  if(status===429)return 'RATE_LIMITED';
  if(status===401)return 'TOKEN_REJECTED';
  if(status===403)return 'FORBIDDEN';
  if(status>=500)return 'TELEGRAM_SERVER_ERROR';
  return 'TELEGRAM_REQUEST_REJECTED';
}
export function safeFailure(error:unknown):string {
  if(error instanceof TelegramError||error instanceof DomainError||error instanceof ModelError) {
    const code=/^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:'UNCLASSIFIED_ERROR';
    const reason=error instanceof TelegramError&&error.reason&&/^[A-Z0-9_]{1,80}$/.test(error.reason)?` ${error.reason}`:'';
    return code+reason;
  }
  return 'INTERNAL_OR_DATABASE_ERROR';
}
export function definiteRejection(error:unknown):boolean {
  return error instanceof TelegramError&&(/^TELEGRAM_(HTTP|API)_4\d\d$/.test(error.code)
    || /^TELEGRAM_(MESSAGE_INVALID|CALLBACK_TOO_LONG|KEYBOARD_INVALID|RENDER_INVALID)$/.test(error.code));
}
