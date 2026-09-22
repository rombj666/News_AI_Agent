import type { NewsCandidate } from '../domain/ports.js';
import { publicHttpsUrl } from './http.js';

export function plainText(value: string): string {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[entity]!)
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (original, number: string) => {
      const code = number[0]?.toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : original;
    }).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
}

export function canonicalUrl(input: string): string {
  // Article URLs may be HTTP; no article page is fetched by this milestone.
  const original = new URL(input);
  if (original.protocol !== 'http:' && original.protocol !== 'https:') throw new Error('INVALID_URL');
  const check = new URL(original); check.protocol = 'https:';
  publicHttpsUrl(check.href);
  original.hostname = original.hostname.replace(/\.$/, '');
  original.hash = '';
  for (const key of [...original.searchParams.keys()]) {
    if (/^utm_/i.test(key) || /^(fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|twclid|ttclid|li_fat_id|mkt_tok|_ga|_gl|vero_id|vero_conv|oly_anon_id|oly_enc_id|ref_src|ref_url|s_cid|sc_cid|hsctatracking|_hsenc|_hsmi)$/i.test(key)) original.searchParams.delete(key);
  }
  // Decode only RFC-unreserved path bytes; %2F and other reserved characters
  // must retain their meaning. URL already normalizes dot segments/default ports.
  original.pathname = original.pathname.replace(/%[0-9a-f]{2}/gi, (encoded) => {
    const character = String.fromCharCode(parseInt(encoded.slice(1), 16));
    return /[A-Za-z0-9._~-]/.test(character) ? character : encoded.toUpperCase();
  });
  original.searchParams.sort();
  // Preserve scheme, path case, trailing slash, and content-bearing query parameters.
  return original.href;
}

export function parseDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const input = value.trim();
  // Date.parse normalizes impossible dates such as February 30. Reject those.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(input);
  if (iso) {
    const year = Number(iso[1]); const month = Number(iso[2]); const day = Number(iso[3]);
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (year < 1000 || month < 1 || month > 12 || day < 1 || day > days) return null;
  }
  const rfc = /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\b/i.exec(input);
  if (rfc) {
    const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(rfc[2]!.toLowerCase()) + 1;
    const day = Number(rfc[1]); const year = Number(rfc[3]);
    if (year < 1000 || day < 1 || day > new Date(Date.UTC(year,month,0)).getUTCDate()) return null;
  }
  // Reject relative ages and timezone-less datetimes to avoid machine-local interpretation.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input) && !/(Z|[+-]\d{2}:?\d{2}|GMT|UTC)$/i.test(input)) return null;
  const time = Date.parse(input);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export interface NormalizedArticle {
  canonicalUrl: string; originalUrl: string; title: string; normalizedTitle: string; titleHash: string;
  source: string; sourceDomain: string; description: string; publishedAt: string | null; fetchedAt: string;
  dateKind: NewsCandidate['dateKind']; contentKind: NewsCandidate['contentKind']; rawMetadata: Record<string, unknown>;
}

export async function normalizeArticle(candidate: NewsCandidate): Promise<NormalizedArticle> {
  const url = canonicalUrl(candidate.url);
  const title = plainText(candidate.title).normalize('NFKC');
  if (!title || title.length > 1000 || url.length > 2048) throw new Error('INVALID_ARTICLE');
  const normalizedTitle = title.toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!normalizedTitle) throw new Error('INVALID_TITLE');
  const sourceDomain = new URL(url).hostname.replace(/^www\./, '');
  const fetchedAt = parseDate(candidate.fetchedAt);
  if (!fetchedAt) throw new Error('INVALID_FETCH_DATE');
  const publishedAt = parseDate(candidate.publishedAt);
  const bucket = (publishedAt ?? fetchedAt).slice(0, 10);
  const hashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${sourceDomain}\n${bucket}\n${normalizedTitle}`));
  const titleHash = [...new Uint8Array(hashBytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
  const serialized = JSON.stringify(candidate.rawMetadata);
  return {
    canonicalUrl: url, originalUrl: candidate.url, title, normalizedTitle, titleHash,
    source: plainText(candidate.source).slice(0, 200) || sourceDomain, sourceDomain,
    description: plainText(candidate.excerpt).slice(0, 10_000), publishedAt, fetchedAt,
    dateKind: publishedAt ? candidate.dateKind : 'unknown', contentKind: candidate.contentKind,
    rawMetadata: new TextEncoder().encode(serialized).length <= 16_000 ? candidate.rawMetadata : { omitted: 'metadata_too_large' },
  };
}
