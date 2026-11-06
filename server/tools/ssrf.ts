// Tools may read the public web and nothing else. The address check runs at connect time, so a name that
// resolves to something public and then to something private is still caught.
import { lookup as dnsLookup } from 'node:dns';
import net from 'node:net';

export function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return isBlocked4(ip);
  if (v === 6) {
    const low = ip.toLowerCase();
    const mapped = low.match(/^(?:0*:)*(?:ffff:)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlocked4(mapped[1]);
    const hex = low.match(/^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const a = parseInt(hex[1], 16);
      const b = parseInt(hex[2], 16);
      return isBlocked4(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
    }
    if (low === '::' || low === '::1') return true;
    const first = parseInt(low.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // unique local
    if ((first & 0xffc0) === 0xfe80) return true; // link local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (first === 0x2001 && low.startsWith('2001:db8')) return true;
    if (first === 0x0064) return true; // nat64
    if (first === 0x2002) return true; // 6to4 can wrap private v4
    return false;
  }
  return true;
}

function isBlocked4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT, also used by private cloud networks
  if (a === 169 && b === 254) return true; // link local and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

export type LookupFn = (hostname: string, cb: (err: Error | null, address?: string, family?: number) => void) => void;

const defaultResolve: LookupFn = (hostname, cb) => dnsLookup(hostname, { all: false }, (e, a, f) => cb(e, a, f));

/** A `lookup` for http.request that refuses private addresses. */
export function guardedLookup(resolve: LookupFn = defaultResolve) {
  return (hostname: string, options: any, cb: any) => {
    const callback = typeof options === 'function' ? options : cb;
    const wantAll = typeof options === 'object' && options?.all;
    resolve(hostname, (err, address, family) => {
      if (err) return callback(err);
      if (!address || isBlockedIp(address)) {
        return callback(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
      }
      if (wantAll) return callback(null, [{ address, family }]);
      callback(null, address, family);
    });
  };
}

export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http and https are allowed');
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('only the standard web ports are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedIp(host)) throw new Error('that address is not public');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('that address is not public');
  }
  if (!net.isIP(host) && !host.includes('.')) throw new Error('that address is not public');
  return u;
}
