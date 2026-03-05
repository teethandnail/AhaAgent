import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

type BrowserSearchEngine = 'duckduckgo' | 'google' | 'bing';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_SNAPSHOT_CHARS = 12_000;

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((x) => Number.parseInt(x, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
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

export async function assertSafeBrowserUrl(
  rawUrl: string,
  lookupFn: (hostname: string) => Promise<Array<{ address: string; family: number }> | { address: string; family: number }> = (hostname) =>
    lookup(hostname, { all: true, verbatim: true }),
): Promise<URL> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;
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

  const resolved = await lookupFn(hostname);
  const addresses = Array.isArray(resolved) ? resolved : [resolved];
  for (const addr of addresses) {
    if ((addr.family === 4 && isPrivateIPv4(addr.address)) || (addr.family === 6 && isPrivateIPv6(addr.address))) {
      throw new Error(`Blocked private resolved address: ${addr.address}`);
    }
  }
  return parsed;
}

function normalizeEngine(engine: unknown): BrowserSearchEngine {
  if (engine === 'google' || engine === 'bing') return engine;
  return 'duckduckgo';
}

function buildSearchUrl(engine: BrowserSearchEngine, query: string): string {
  const q = encodeURIComponent(query);
  switch (engine) {
    case 'google':
      return `https://www.google.com/search?q=${q}&num=10&hl=zh-CN`;
    case 'bing':
      return `https://www.bing.com/search?q=${q}&setlang=zh-CN`;
    case 'duckduckgo':
    default:
      return `https://duckduckgo.com/?q=${q}`;
  }
}

function readHeadlessFlag(): boolean {
  const raw = (process.env.AHA_BROWSER_HEADLESS ?? '0').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no');
}

function readCdpUrl(): string | null {
  const raw = process.env.AHA_BROWSER_CDP_URL;
  if (!raw) return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

type SearchResult = { id: string; title: string; url: string; snippet: string };

type BrowserRuntime = {
  chromium: {
    launch: (opts: { headless: boolean; channel?: string }) => Promise<unknown>;
    connectOverCDP: (endpointURL: string) => Promise<unknown>;
  };
};

export class BrowserAutomationService {
  private runtime: BrowserRuntime | null = null;
  private browser: unknown | null = null;
  private context: unknown | null = null;
  private page: unknown | null = null;
  private lastResults: SearchResult[] = [];

  private async loadRuntime(): Promise<BrowserRuntime> {
    if (this.runtime) return this.runtime;
    const moduleName = 'playwright';
    try {
      const mod = (await import(moduleName)) as unknown as BrowserRuntime;
      this.runtime = mod;
      return mod;
    } catch {
      throw new Error(
        'playwright is not installed. Run: npm i -w packages/server playwright && npx playwright install chromium',
      );
    }
  }

  private getPage(): {
    goto: (url: string, opts?: { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }) => Promise<void>;
    title: () => Promise<string>;
    url: () => string;
    evaluate: <T>(fn: () => T) => Promise<T>;
    click: (selector: string, opts?: { timeout?: number }) => Promise<void>;
    fill: (selector: string, text: string, opts?: { timeout?: number }) => Promise<void>;
    keyboard: { press: (key: string) => Promise<void> };
    close: () => Promise<void>;
  } {
    if (!this.page) {
      throw new Error('Browser session is not started');
    }
    return this.page as ReturnType<BrowserAutomationService['getPage']>;
  }

  async start(): Promise<{ ok: true; output: { started: true } }> {
    if (this.page) return { ok: true, output: { started: true } };
    const runtime = await this.loadRuntime();
    const cdpUrl = readCdpUrl();

    if (cdpUrl) {
      const browser = (await runtime.chromium.connectOverCDP(cdpUrl)) as {
        contexts?: () => unknown[] | Promise<unknown[]>;
        newContext?: () => Promise<unknown>;
        close: () => Promise<void>;
      };
      const contexts = typeof browser.contexts === 'function' ? await browser.contexts() : [];
      const context = (contexts[0] ??
        (typeof browser.newContext === 'function' ? await browser.newContext() : null)) as
        | {
            pages?: () => unknown[] | Promise<unknown[]>;
            newPage?: () => Promise<unknown>;
            close: () => Promise<void>;
          }
        | null;
      if (!context) {
        throw new Error('No available browser context from CDP endpoint');
      }
      const pages = typeof context.pages === 'function' ? await context.pages() : [];
      const page = (pages[0] ??
        (typeof context.newPage === 'function' ? await context.newPage() : null)) as unknown | null;
      if (!page) {
        throw new Error('No available page from CDP browser context');
      }
      this.browser = browser;
      this.context = context;
      this.page = page;
      return { ok: true, output: { started: true } };
    }

    const launchChannel = (process.env.AHA_BROWSER_CHANNEL ?? '').trim();
    const browser = (await runtime.chromium.launch({
      headless: readHeadlessFlag(),
      ...(launchChannel ? { channel: launchChannel } : {}),
    })) as {
      newContext: () => Promise<unknown>;
      close: () => Promise<void>;
    };
    const context = (await browser.newContext()) as {
      newPage: () => Promise<unknown>;
      close: () => Promise<void>;
    };
    const page = (await context.newPage()) as unknown;
    this.browser = browser;
    this.context = context;
    this.page = page;
    return { ok: true, output: { started: true } };
  }

  async stop(): Promise<{ ok: true; output: { stopped: true } }> {
    const page = this.page as { close: () => Promise<void> } | null;
    const context = this.context as { close: () => Promise<void> } | null;
    const browser = this.browser as { close: () => Promise<void> } | null;

    this.page = null;
    this.context = null;
    this.browser = null;
    this.lastResults = [];

    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    return { ok: true, output: { stopped: true } };
  }

  async status(): Promise<{ ok: true; output: { running: boolean; currentUrl?: string; title?: string } }> {
    if (!this.page) return { ok: true, output: { running: false } };
    const page = this.getPage();
    return {
      ok: true,
      output: {
        running: true,
        currentUrl: page.url(),
        title: await page.title().catch(() => ''),
      },
    };
  }

  async search(input: {
    query: string;
    engine?: unknown;
    maxResults?: number;
    timeoutMs?: number;
  }): Promise<{ ok: true; output: { engine: BrowserSearchEngine; query: string; results: SearchResult[] } }> {
    const query = input.query.trim();
    if (!query) throw new Error('query is required');

    await this.start();
    const page = this.getPage();
    const engine = normalizeEngine(input.engine);
    const maxResults = typeof input.maxResults === 'number' && Number.isFinite(input.maxResults)
      ? Math.max(1, Math.min(10, Math.floor(input.maxResults)))
      : 5;
    const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? Math.max(2_000, Math.min(60_000, Math.floor(input.timeoutMs)))
      : DEFAULT_TIMEOUT_MS;
    const searchUrl = buildSearchUrl(engine, query);
    await assertSafeBrowserUrl(searchUrl);
    await page.goto(searchUrl, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });

    const parsed = await page.evaluate(() => {
      const doc = (globalThis as { document?: { querySelectorAll: (sel: string) => unknown[] } }).document;
      const bySelector = (sel: string) => (doc ? Array.from(doc.querySelectorAll(sel)) : []);
      const rows: Array<{ title: string; url: string; snippet: string }> = [];
      const push = (title: string, url: string, snippet: string) => {
        const t = title.trim();
        const u = url.trim();
        const s = snippet.trim();
        if (!t || !u) return;
        rows.push({ title: t, url: u, snippet: s });
      };

      // Google
      for (const node of bySelector('div#search div.g')) {
        const entry = node as {
          querySelector: (selector: string) => { textContent?: string | null; href?: string } | null;
        };
        const link = entry.querySelector('a[href]');
        const titleNode = entry.querySelector('h3');
        const snippetNode = entry.querySelector('div.VwiC3b, span.aCOpRe');
        if (link?.href && titleNode?.textContent) {
          push(titleNode.textContent, link.href, snippetNode?.textContent ?? '');
        }
      }

      // Bing
      for (const node of bySelector('li.b_algo')) {
        const entry = node as {
          querySelector: (selector: string) => { textContent?: string | null; href?: string } | null;
        };
        const link = entry.querySelector('h2 a[href]');
        const snippetNode = entry.querySelector('.b_caption p');
        if (link?.href && link.textContent) {
          push(link.textContent, link.href, snippetNode?.textContent ?? '');
        }
      }

      // DuckDuckGo
      for (const node of bySelector('[data-testid=\"result\"]')) {
        const entry = node as {
          querySelector: (selector: string) => { textContent?: string | null; href?: string } | null;
        };
        const link = entry.querySelector('a[data-testid=\"result-title-a\"], a[href]');
        const snippetNode = entry.querySelector('[data-result=\"snippet\"], [data-testid=\"result-snippet\"]');
        if (link?.href && link.textContent) {
          push(link.textContent, link.href, snippetNode?.textContent ?? '');
        }
      }
      for (const node of bySelector('article[data-testid=\"result\"]')) {
        const entry = node as {
          querySelector: (selector: string) => { textContent?: string | null; href?: string } | null;
        };
        const link = entry.querySelector('a[href]');
        const snippetNode = entry.querySelector('[data-result=\"snippet\"], [data-testid=\"result-snippet\"]');
        if (link?.href && link.textContent) {
          push(link.textContent, link.href, snippetNode?.textContent ?? '');
        }
      }

      return rows;
    });

    const deduped = new Map<string, SearchResult>();
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      if (!item) continue;
      try {
        const safe = await assertSafeBrowserUrl(item.url);
        const key = safe.toString();
        if (deduped.has(key)) continue;
        deduped.set(key, {
          id: `r${(deduped.size + 1).toString()}`,
          title: item.title,
          url: key,
          snippet: item.snippet,
        });
      } catch {
        // Skip unsafe URLs.
      }
      if (deduped.size >= maxResults) break;
    }

    const results = [...deduped.values()];
    this.lastResults = results;
    return {
      ok: true,
      output: { engine, query, results },
    };
  }

  async open(input: { url: string; timeoutMs?: number }): Promise<{ ok: true; output: { url: string; title: string } }> {
    const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? Math.max(2_000, Math.min(60_000, Math.floor(input.timeoutMs)))
      : DEFAULT_TIMEOUT_MS;
    const safe = await assertSafeBrowserUrl(input.url);
    await this.start();
    const page = this.getPage();
    await page.goto(safe.toString(), { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    return { ok: true, output: { url: page.url(), title: await page.title() } };
  }

  async clickResult(input: { index: number; timeoutMs?: number }): Promise<{ ok: true; output: { index: number; url: string; title: string } }> {
    const idx = Math.floor(input.index);
    if (!Number.isFinite(idx) || idx < 1) throw new Error('index must be >= 1');
    const target = this.lastResults[idx - 1];
    if (!target) {
      throw new Error(`No search result at index ${idx.toString()}`);
    }
    await this.open({ url: target.url, timeoutMs: input.timeoutMs });
    const page = this.getPage();
    return {
      ok: true,
      output: {
        index: idx,
        url: page.url(),
        title: await page.title(),
      },
    };
  }

  async click(input: { selector: string; timeoutMs?: number }): Promise<{ ok: true; output: { clicked: string } }> {
    await this.start();
    const page = this.getPage();
    const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? Math.max(2_000, Math.min(60_000, Math.floor(input.timeoutMs)))
      : DEFAULT_TIMEOUT_MS;
    await page.click(input.selector, { timeout: timeoutMs });
    return { ok: true, output: { clicked: input.selector } };
  }

  async type(input: {
    selector: string;
    text: string;
    submit?: boolean;
    timeoutMs?: number;
  }): Promise<{ ok: true; output: { typed: string; submit: boolean } }> {
    await this.start();
    const page = this.getPage();
    const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? Math.max(2_000, Math.min(60_000, Math.floor(input.timeoutMs)))
      : DEFAULT_TIMEOUT_MS;
    await page.fill(input.selector, input.text, { timeout: timeoutMs });
    if (input.submit) {
      await page.keyboard.press('Enter');
    }
    return { ok: true, output: { typed: input.selector, submit: Boolean(input.submit) } };
  }

  async snapshot(input?: { maxChars?: number }): Promise<{
    ok: true;
    output: {
      url: string;
      title: string;
      text: string;
      links: Array<{ text: string; url: string }>;
    };
  }> {
    await this.start();
    const page = this.getPage();
    const maxChars = input?.maxChars && Number.isFinite(input.maxChars)
      ? Math.max(500, Math.min(50_000, Math.floor(input.maxChars)))
      : DEFAULT_MAX_SNAPSHOT_CHARS;
    const data = await page.evaluate(() => {
      const doc = (globalThis as {
        document?: {
          body?: { innerText?: string };
          querySelectorAll: (sel: string) => unknown[];
        };
      }).document;
      const text = (doc?.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      const links = (doc ? Array.from(doc.querySelectorAll('a[href]')) : [])
        .slice(0, 50)
        .map((a) => {
          const link = a as { textContent?: string | null; href?: string };
          return {
            text: (link.textContent ?? '').trim(),
            url: link.href ?? '',
          };
        })
        .filter((x) => x.text || x.url);
      return { text, links };
    });
    const links: Array<{ text: string; url: string }> = [];
    for (const item of data.links) {
      try {
        const safe = await assertSafeBrowserUrl(item.url);
        links.push({ text: item.text, url: safe.toString() });
      } catch {
        // Skip unsafe URLs.
      }
    }

    return {
      ok: true,
      output: {
        url: page.url(),
        title: await page.title(),
        text: data.text.slice(0, maxChars),
        links,
      },
    };
  }
}
