export type NewsIntent='NEWS_NOW'|'CURRENT_NEWS_QUESTION'|'PERMANENT_PREFERENCE'|'SCHEDULE_CHANGE'|'TEMPORARY_INTEREST'|'STORY_QUESTION'|'COMMAND'|'UNSUPPORTED';

export function classifyMessage(raw:string):NewsIntent {
  const text=raw.trim().toLowerCase().replace(/[’‘]/g,"'");
  if(/^\/news(?:\s|$)/.test(text))return 'NEWS_NOW';
  if(/^\/schedule(?:\s|$)/.test(text))return 'SCHEDULE_CHANGE';
  if(text.startsWith('/'))return 'COMMAND';
  if(/\bstory\s*\d+\b|explain deeper|more detail|explain the background/.test(text))return 'STORY_QUESTION';
  // A bounded duration is temporary only when paired with an instruction to
  // change focus/preferences, never merely because a news query mentions time.
  const duration=/\b(today|this week|this month|temporarily|for now|until)\b/.test(text);
  const mutation=/\b(focus on|prioriti[sz]e|prefer|stop showing|exclude|more|less)\b/.test(text);
  if(duration&&mutation)return 'TEMPORARY_INTEREST';
  if(/\b(send my news|delivery|timezone|time zone|uk time)\b/.test(text)
    ||/\b(change|set|move|enable|disable|stop|resume)\b.*\b(briefing|schedule)\b/.test(text))return 'SCHEDULE_CHANGE';
  if(/\b(every day|daily|from now on|always|future briefings)\b/.test(text)&&/\b(give|show|send|more|less|prefer|focus)\b/.test(text))return 'PERMANENT_PREFERENCE';
  if(/\b(more|less|stop(?: showing)?|exclude|prefer|priority|digest|language)\b/.test(text))return 'PERMANENT_PREFERENCE';
  if(/^(?:what(?:'s| is| happened)|what happened|any important|is there|are there|how (?:is|are)|why (?:is|are|did))\b/.test(text))return 'CURRENT_NEWS_QUESTION';
  if(/\b(news|latest|search|look up)\b/.test(text))return 'NEWS_NOW';
  return 'UNSUPPORTED';
}
