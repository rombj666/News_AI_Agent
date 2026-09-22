export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export class RetrievalError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'RetrievalError'; }
}

// Feed URLs are operator-controlled configuration, never arbitrary chat input.
// DNS/network egress restrictions are additionally required before public URL submission.
export function publicHttpsUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || host.endsWith('.internal') || !host.includes('.') || host.includes(':')
    || /^\d+\.\d+\.\d+\.\d+$/.test(host)) throw new RetrievalError('UNSAFE_URL');
  return url;
}

export async function fetchText(
  fetcher: Fetcher, url: string, init: RequestInit, signal: AbortSignal, maxBytes = 2_000_000,
): Promise<{ response: Response; text: string }> {
  try {
    signal.throwIfAborted();
    const response = await fetcher(url, { ...init, redirect: 'error', signal });
    if (response.status === 304) return { response, text: '' };
    if (!response.ok) {
      await response.body?.cancel();
      throw new RetrievalError(`HTTP_${response.status}`);
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new RetrievalError('RESPONSE_TOO_LARGE');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new RetrievalError('EMPTY_RESPONSE');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) throw new RetrievalError('RESPONSE_TOO_LARGE');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const merged = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    return { response, text: new TextDecoder('utf-8', { fatal: true }).decode(merged) };
  } catch (error) {
    if (error instanceof RetrievalError) throw error;
    // Never persist exceptions containing credential headers, query URLs, or response bodies.
    throw new RetrievalError(signal.aborted ? 'ABORTED_OR_TIMEOUT' : 'NETWORK_OR_ENCODING_ERROR');
  }
}
