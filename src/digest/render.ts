import type { Digest } from './types.js';

const plain = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').trim();
// Plain text only. Future channel renderers must escape their own markup.
export function renderDigest(digest: Digest): string {
  const lines = [plain(digest.title)];
  let position = 0;
  for (const section of digest.sections) {
    if (!section.items.length) continue;
    lines.push('',plain(section.name));
    for (const item of section.items) {
      lines.push(`${++position}. ${plain(item.headline)}`,plain(item.summary),
        `Why it matters: ${plain(item.whyItMatters)}`,
        `Sources: ${item.sources.map(s => `${plain(s.name)} (${s.url})`).join('; ')}`);
    }
  }
  return lines.join('\n');
}
