import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Clock, NewsCandidate, NewsRetriever, RetrievalBatch, RetrievalRequest } from '../domain/ports.js';
import { systemClock } from '../domain/ports.js';
import { fetchText, RetrievalError, type Fetcher } from './http.js';
import { parseDate } from './normalize.js';
import { rssSourceSchema, type RssSource } from './sources.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string => typeof value === 'string' ? value : typeof object(value)['#text'] === 'string' ? object(value)['#text'] as string : '';

export class RssRetriever implements NewsRetriever {
  readonly provider = 'rss' as const;
  readonly source: RssSource;
  constructor(source: RssSource, private fetcher: Fetcher = fetch, private clock: Clock = systemClock) {
    this.source = rssSourceSchema.parse(source);
  }
  async collect(request: RetrievalRequest): Promise<RetrievalBatch> {
    if (!this.source.enabled) throw new RetrievalError('SOURCE_DISABLED');
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) throw new RetrievalError('INVALID_FEED_LIMIT');
    const headers: Record<string, string> = { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', 'User-Agent': 'PersonalNewsAgent/0.2' };
    if (request.etag) headers['If-None-Match'] = request.etag;
    if (request.lastModified) headers['If-Modified-Since'] = request.lastModified;
    const { response, text: xml } = await fetchText(this.fetcher, this.source.url, { headers }, request.signal);
    const base = { notModified: response.status === 304, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
    if (base.notModified) return { ...base, items: [], fetched: 0, failures: [] };
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new RetrievalError('XML_DECLARATIONS_FORBIDDEN');
    if (XMLValidator.validate(xml) !== true) throw new RetrievalError('INVALID_XML');
    let doc: Record<string, unknown>;
    try {
      doc = object(new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false,
        removeNSPrefix: true, processEntities: true, trimValues: true }).parse(xml));
    } catch { throw new RetrievalError('INVALID_XML'); }
    const atom = doc.feed !== undefined;
    const channel = atom ? object(doc.feed) : object(object(doc.rss).channel);
    if (doc.feed === undefined && object(doc.rss).channel === undefined) throw new RetrievalError('UNSUPPORTED_FEED');
    const entries = list(atom ? channel.entry : channel.item).slice(0, request.limit);
    const items: NewsCandidate[] = [];
    const failures: RetrievalBatch['failures'] = [];
    const fetchedAt = this.clock.now().toISOString();
    entries.forEach((raw, index) => {
      const item = object(raw);
      const title = text(item.title);
      let link = text(item.link);
      if (atom) {
        const alternative = list(item.link).map(object).find((entry) => !entry['@_rel'] || entry['@_rel'] === 'alternate');
        link = text(alternative?.['@_href']);
      }
      if (!title || !link) { failures.push({ code: 'INVALID_FEED_ITEM', index }); return; }
      let url: string;
      try { url = new URL(link, this.source.url).href; }
      catch { failures.push({ code: 'INVALID_FEED_URL', index }); return; }
      // Atom updated is a modification time, not a publication time.
      const rawDate = atom ? item.published : item.pubDate ?? item.date;
      const publishedAt = parseDate(rawDate);
      items.push({ url, title, source: this.source.name, publishedAt, fetchedAt,
        excerpt: text(atom ? item.summary ?? item.content : item.description ?? item.encoded),
        contentKind: 'feed_excerpt', dateKind: publishedAt ? 'published' : 'unknown',
        rawMetadata: { guid: text(item.guid ?? item.id), published: text(rawDate), updated: text(item.updated), category: item.category ?? null },
      });
    });
    return { ...base, items, fetched: entries.length, failures };
  }
}
