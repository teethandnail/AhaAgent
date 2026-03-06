import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(input: string): string {
  const withoutScripts = input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  return decodeHtmlEntities(withoutScripts.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const raw = m?.[1];
  return raw ? decodeHtmlEntities(raw.trim()) : '';
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((x) => Number.parseInt(x, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe80:')) return true;
  return false;
}

function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost');
}

async function assertSafeDestination(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }

  const hostname = url.hostname;
  if (isLocalHostname(hostname)) {
    throw new Error(`Blocked local hostname: ${hostname}`);
  }

  const ipType = isIP(hostname);
  if (ipType === 4 && isPrivateIPv4(hostname)) {
    throw new Error(`Blocked private IPv4: ${hostname}`);
  }
  if (ipType === 6 && isPrivateIPv6(hostname)) {
    throw new Error(`Blocked private IPv6: ${hostname}`);
  }

  const resolved = await lookup(hostname, { all: true, verbatim: true });
  for (const addr of resolved) {
    if ((addr.family === 4 && isPrivateIPv4(addr.address)) || (addr.family === 6 && isPrivateIPv6(addr.address))) {
      throw new Error(`Blocked private resolved address: ${addr.address}`);
    }
  }
}

async function readBodyWithLimit(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      const excess = total - maxBytes;
      chunks.push(value.slice(0, value.byteLength - excess));
      reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }

  let finalSize = 0;
  for (const chunk of chunks) finalSize += chunk.byteLength;
  const merged = new Uint8Array(finalSize);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(merged);
}

export async function fetchUrlWithSafety(input: {
  url: string;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<{ finalUrl: string; status: number; title: string; text: string; html: string }> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const attempts = 2;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let current = new URL(input.url);
    try {
      for (let i = 0; i <= MAX_REDIRECTS; i++) {
        await assertSafeDestination(current);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(current, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
            },
          });

          if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location');
            if (!location) {
              throw new Error(`Redirect without location header (${res.status.toString()})`);
            }
            current = new URL(location, current);
            continue;
          }

          const html = await readBodyWithLimit(res, maxBytes);
          return {
            finalUrl: current.toString(),
            status: res.status,
            title: extractTitle(html),
            text: stripHtml(html),
            html,
          };
        } finally {
          clearTimeout(timer);
        }
      }

      throw new Error(`Too many redirects (>${MAX_REDIRECTS.toString()})`);
    } catch (error: unknown) {
      const isAbort =
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('aborted'));
      if (!isAbort || attempt === attempts - 1) {
        throw error;
      }
    }
  }

  throw new Error('Request failed after retries');
}

function unwrapDuckDuckGoLink(rawHref: string): string {
  try {
    const url = new URL(rawHref, 'https://duckduckgo.com');
    if (url.hostname.endsWith('duckduckgo.com')) {
      const uddg = url.searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
    }
  } catch {
    // fall through
  }
  return rawHref;
}

export async function searchWebDuckDuckGo(query: string, maxResults = 5): Promise<{
  results: Array<{ id: string; title: string; url: string; snippet: string }>;
}> {
  if (!query.trim()) return { results: [] };
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const fetched = await fetchUrlWithSafety({
    url: searchUrl,
    timeoutMs: 20_000,
    maxBytes: 400 * 1024,
  });

  const links = [...fetched.html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...fetched.html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)];
  const results: Array<{ id: string; title: string; url: string; snippet: string }> = [];

  for (let i = 0; i < links.length && results.length < maxResults; i++) {
    const link = links[i];
    if (!link) continue;
    const hrefRaw = link[1];
    const titleRaw = link[2];
    if (!hrefRaw || !titleRaw) continue;

    const href = unwrapDuckDuckGoLink(decodeHtmlEntities(hrefRaw));
    const title = stripHtml(titleRaw);
    if (!href || !title) continue;
    const snippetRaw = snippets[i]?.[1];
    results.push({
      id: `r${(i + 1).toString()}`,
      title,
      url: href,
      snippet: snippetRaw ? stripHtml(snippetRaw) : '',
    });
  }

  return { results };
}

export function extractMainContent(html: string): { title: string; markdown: string } {
  const title = extractTitle(html);
  const text = stripHtml(html)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 12_000);
  return { title, markdown: text };
}
