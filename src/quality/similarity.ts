import { plainText } from '../retrieval/normalize.js';

const stop = new Set('a an the and or for to of in on at by with from as its it is are be was were this that new latest breaking news report reports says said today after before amid over about'.split(' '));
const aliases: Record<string, string> = {
  announces: 'launch', announced: 'launch', announce: 'launch', launches: 'launch', launched: 'launch', launching: 'launch',
  unveils: 'launch', unveiled: 'launch', unveil: 'launch', introduces: 'launch', introduced: 'launch',
  releases: 'launch', released: 'launch', release: 'launch',
  chips: 'chip', models: 'model', tools: 'tool', agents: 'agent', results: 'result',
  rises: 'rise', surges: 'rise', gains: 'rise', falls: 'fall', drops: 'fall', plunges: 'fall',
  approves: 'approve', approved: 'approve', rejects: 'reject', rejected: 'reject',
  delays: 'delay', delayed: 'delay', cancels: 'cancel', cancelled: 'cancel',
  wins: 'win', loses: 'lose', profits: 'profit', losses: 'loss',
};
const generic = new Set([...stop, 'ai','artificial','intelligence','company','technology','tech','model','launch','update','global','world']);
const opposing = [['rise','fall'],['approve','reject'],['launch','delay'],['launch','cancel'],['win','lose'],['profit','loss']];

export function titleFeatures(title: string, sourceName = '') {
  let cleaned = plainText(title).normalize('NFKC').replace(/\bartificial intelligence\b/gi, 'AI');
  // Remove only an explicit terminal publisher suffix, not arbitrary title words.
  const escaped = sourceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (escaped) cleaned = cleaned.replace(new RegExp(`\\s+(?:\\||[-–—])\\s+${escaped}$`, 'i'), '');
  const words = cleaned.match(/[\p{L}\p{N}]+/gu) ?? [];
  const exact = words.map((word) => word.toLowerCase()).join(' ');
  const tokens = new Set(words.map((word) => aliases[word.toLowerCase()] ?? word.toLowerCase()).filter((word) => !stop.has(word)));
  const entities = new Set(words.filter((word) => /^[A-Z]/.test(word) && !generic.has(word.toLowerCase()) && !aliases[word.toLowerCase()])
    .map((word) => word.toLowerCase()));
  const numbers = new Set(words.filter((word) => /^\d+$/.test(word)));
  const negated = words.some((word) => /^(not|no|never|denies|deny)$/i.test(word));
  return { exact, tokens, entities, numbers, negated };
}

export function titleSimilarity(a: ReturnType<typeof titleFeatures>, b: ReturnType<typeof titleFeatures>) {
  const shared = [...a.tokens].filter((token) => b.tokens.has(token));
  const union = new Set([...a.tokens, ...b.tokens]).size;
  const score = union ? shared.length / union : 0;
  const numbersConflict = a.numbers.size > 0 && b.numbers.size > 0 && [...new Set([...a.numbers,...b.numbers])].some((number) => !a.numbers.has(number) || !b.numbers.has(number));
  const actionConflict = opposing.some(([left, right]) => (a.tokens.has(left!) && b.tokens.has(right!)) || (b.tokens.has(left!) && a.tokens.has(right!)));
  const aOnly = [...a.entities].filter((entity) => !b.entities.has(entity));
  const bOnly = [...b.entities].filter((entity) => !a.entities.has(entity));
  // Conservative entity guard prevents 'Google launches AI model' matching OpenAI,
  // or two different partners matching just because Microsoft appears in both.
  const entityConflict = aOnly.length > 0 && bOnly.length > 0;
  return { score, shared: shared.length, compatible: !numbersConflict && !actionConflict && !entityConflict && a.negated === b.negated };
}
