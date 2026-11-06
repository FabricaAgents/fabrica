// The web_fetch tool: public http(s) pages only, a domain allowlist when the spec names one, size and time limits.
import http from 'node:http';
import https from 'node:https';
import { checkUrl, guardedLookup, type LookupFn } from './ssrf';

const UA = 'FabricaAgent/1.0 (+https://getfabrica.fun/docs)';
const MAX_BYTES = 1_000_000;

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}

export class BlockedUrl extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BlockedUrl';
  }
}

export function domainAllowed(host: string, allow: string[]): boolean {
  if (!allow.length) return true;
  const h = host.toLowerCase().replace(/\.$/, '');
  return allow.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Validates a URL before any request: scheme, port, private names and literal addresses, and the allowlist. */
export function precheck(raw: string, allow: string[]): URL {
  let u: URL;
  try {
    u = checkUrl(raw);
  } catch (e) {
    throw new BlockedUrl((e as Error).message);
  }
  if (!domainAllowed(u.hostname, allow)) throw new BlockedUrl(`${u.hostname} is not on this agent's list of allowed sites`);
  return u;
}

function requestOnce(u: URL, timeoutMs: number, lookup: any): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { method: 'GET', lookup, timeout: timeoutMs, headers: { 'user-agent': UA, accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.2' } },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        res.on('data', (c: Buffer) => {
          if (done) return;
          size += c.length;
          if (size > MAX_BYTES) {
            done = true;
            res.destroy();
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated: true });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => !done && resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated: false }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

export function htmlToText(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/[ \t\f\r]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n')
    .trim();
  return title ? `Title: ${title}\n${body}` : body;
}

export async function fetchPublicPage(raw: string, opts: { allow?: string[]; timeoutMs?: number; maxChars?: number; resolve?: LookupFn } = {}): Promise<FetchedPage> {
  const allow = opts.allow ?? [];
  const lookup = guardedLookup(opts.resolve);
  let u = precheck(raw, allow);
  for (let hop = 0; hop < 4; hop++) {
    let r;
    try {
      r = await requestOnce(u, opts.timeoutMs ?? 8000, lookup);
    } catch (e) {
      if ((e as { code?: string }).code === 'EBLOCKED') throw new BlockedUrl('that address is not public');
      throw e;
    }
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      u = precheck(new URL(String(r.headers.location), u).toString(), allow);
      continue;
    }
    const type = String(r.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type && !/^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml))/.test(type)) throw new Error(`cannot read content of type ${type}`);
    const body = r.body.toString('utf8');
    const text = type.includes('html') || !type ? htmlToText(body) : body;
    const max = opts.maxChars ?? 6000;
    return { url: u.toString(), status: r.status, contentType: type, text: text.slice(0, max), truncated: r.truncated || text.length > max };
  }
  throw new Error('too many redirects');
}
