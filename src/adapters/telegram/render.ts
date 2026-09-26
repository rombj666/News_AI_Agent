import type { Digest } from '../../digest/types.js';
import { canonicalUrl } from '../../retrieval/normalize.js';
import { safeImageUrl } from '../../retrieval/images.js';
import { TelegramError,type TelegramButton, type TelegramMessage } from './types.js';
import { z } from 'zod';

const storedDigestShape=z.object({id:z.uuid(),generatedAt:z.string().refine(s=>Number.isFinite(Date.parse(s))),title:z.string().min(1),
  sections:z.array(z.object({name:z.string(),items:z.array(z.object({headline:z.string(),summary:z.string(),whyItMatters:z.string(),
    sources:z.array(z.object({name:z.string(),url:z.string()})).max(10)})).max(30)})).max(30)});

export const cleanText=(text:string)=>text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').trim();
export const escapeHtml=(text:string)=>cleanText(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// Split untrusted plain text BEFORE escaping/adding markup; never split entities,
// surrogate pairs, or source URLs (source URLs live in buttons, not prose).
export function renderText(text:string):TelegramMessage[] {
  const chunks:string[]=[]; let current='';
  for(const word of cleanText(text).match(/\S+\s*/gu)??[]) {
    if(escapeHtml(current+word).length<=3500) {current+=word;continue;}
    if(current.trim()) {chunks.push(current.trim());current='';}
    if(escapeHtml(word).length<=3500) {current=word;continue;}
    if(/^https?:\/\//i.test(word)) {current='[Long link omitted; use the source buttons.] ';continue;}
    for(const character of word) {
      if(escapeHtml(current+character).length>3500) {chunks.push(current);current='';}
      current+=character;
    }
  }
  if(current.trim()) chunks.push(current.trim());
  return chunks.map(plain=>({plain,html:escapeHtml(plain)}));
}

export function renderTelegramDigest(digest:Digest):TelegramMessage[] {
  if(!storedDigestShape.safeParse(digest).success)throw new TelegramError('TELEGRAM_RENDER_INVALID',null,'SAVED_DIGEST_INVALID');
  if(digest.sections.reduce((n,s)=>n+s.items.length,0)>30)throw new TelegramError('TELEGRAM_RENDER_INVALID',null,'STORY_COUNT_INVALID');
  const date=new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(digest.generatedAt));
  const messages=renderText(`☀️ ${digest.title}\n${date}`);
  let position=0;
  for(const section of digest.sections) for(const item of section.items) {
    position++;
    const label=section.name==='Top Stories'?'🔥 Top Stories':section.name==='AI & Technology'?'🤖 AI & Technology':section.name;
    const text=`${label}\n\n${position}. ${item.headline}\n\n${item.summary}\n\nWhy it matters: ${item.whyItMatters}\n\nSource: ${item.sources.map(s=>s.name).join('; ')}`;
    const parts=renderText(text);
    const buttons:TelegramButton[][]=[];
    for(const [i,source] of item.sources.entries()) {
      try { canonicalUrl(source.url); buttons.push([{text:i===0?'Read Source':`Source ${i+1}`,url:source.url}]); }
      catch { /* Never send an unsafe link from a malformed saved record. */ }
    }
    const explain={text:'Explain',callback_data:`e:${digest.id}:${position}`};
    if(buttons[0])buttons[0].push(explain);else buttons.push([explain]);
    buttons.push(
      [{text:'More Like This',callback_data:`m:${digest.id}:${position}`},{text:'Less Like This',callback_data:`l:${digest.id}:${position}`}]);
    const imageUrl=item.sources.map(s=>safeImageUrl(s.imageUrl)).find(Boolean);
    for(const [i,part] of parts.entries()) messages.push({...part,digestId:digest.id,storyPosition:position,
      ...(imageUrl&&parts.length===1&&part.html.length<=1024?{imageUrl}:{}),
      ...(i===parts.length-1?{buttons}:{})});
  }
  return messages;
}
