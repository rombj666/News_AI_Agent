import { z } from 'zod';
import type { Clock, NewsRetriever, RetrievalRequest, RetrievalBatch } from '../domain/ports.js';
import { systemClock } from '../domain/ports.js';
import { fetchText, RetrievalError, type Fetcher } from './http.js';
import { parseDate } from './normalize.js';

const resultSchema = z.object({
  title: z.string().min(1), url: z.string().min(1), description: z.string().nullable().optional(),
  age: z.string().nullable().optional(), page_age: z.string().nullable().optional(),
  profile: z.object({ name: z.string().optional(), long_name: z.string().nullable().optional() }).nullable().optional(),
  extra_snippets: z.array(z.string()).nullable().optional(),
});

export class BraveRetriever implements NewsRetriever {
  readonly provider = 'brave' as const;
  constructor(private apiKey: string, private fetcher: Fetcher = fetch, private clock: Clock = systemClock) {
    if (!apiKey.trim()) throw new Error('BRAVE_API_KEY required');
  }
  async collect(request: RetrievalRequest): Promise<RetrievalBatch> {
    if (!request.query.trim() || request.query.length > 400 || request.query.trim().split(/\s+/).length > 50
      || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50) throw new RetrievalError('INVALID_SEARCH_REQUEST');
    const url = new URL('https://api.search.brave.com/res/v1/news/search');
    url.searchParams.set('q', request.query);
    url.searchParams.set('count', String(request.limit));
    url.searchParams.set('country', 'ALL');
    url.searchParams.set('search_lang', 'en');
    url.searchParams.set('spellcheck', 'false');
    url.searchParams.set('freshness', `${request.since.toISOString().slice(0, 10)}to${this.clock.now().toISOString().slice(0, 10)}`);
    const { response, text } = await fetchText(this.fetcher, url.href, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey },
    }, request.signal);
    if (response.status === 304) throw new RetrievalError('INVALID_BRAVE_RESPONSE');
    let results: unknown[];
    try { results = z.object({ results: z.array(z.unknown()) }).parse(JSON.parse(text)).results.slice(0, request.limit); }
    catch { throw new RetrievalError('INVALID_BRAVE_RESPONSE'); }
    const batch: RetrievalBatch = { items: [], fetched: results.length, failures: [], notModified: false, etag: null, lastModified: null };
    const fetchedAt = this.clock.now().toISOString();
    results.forEach((raw, index) => {
      const parsed = resultSchema.safeParse(raw);
      if (!parsed.success) { batch.failures.push({ code: 'INVALID_BRAVE_ITEM', index }); return; }
      const item = parsed.data;
      const publishedAt = parseDate(item.page_age);
      let source: string;
      try { source = item.profile?.long_name ?? item.profile?.name ?? new URL(item.url).hostname; }
      catch { batch.failures.push({ code: 'INVALID_BRAVE_URL', index }); return; }
      batch.items.push({ url: item.url, title: item.title, source, publishedAt, fetchedAt,
        excerpt: item.description ?? '', contentKind: 'snippet', dateKind: publishedAt ? 'page_age' : 'unknown',
        rawMetadata: { page_age: item.page_age ?? null, age: item.age ?? null, extra_snippets: item.extra_snippets?.slice(0, 5) ?? [] },
      });
    });
    return batch;
  }
}
