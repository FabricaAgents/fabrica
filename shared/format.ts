// Every number on a page goes through here.

/** micro-USDC to a dollar string. Small amounts keep enough digits to be honest about them. */
export function usd(micros: number, opts: { plain?: boolean } = {}): string {
  const v = micros / 1e6;
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  let s: string;
  if (a === 0) s = '0.00';
  else if (a < 0.01) s = a.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.00');
  else if (a < 1) s = a.toFixed(3).replace(/0$/, '');
  else if (a < 10_000) s = a.toFixed(2);
  else s = Math.round(a).toLocaleString('en-US');
  return opts.plain ? `${sign}${s}` : `${sign}$${s}`;
}

export function usdcFromMicros(micros: number | string | bigint): string {
  return usd(Number(micros));
}

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function shortAddr(a: string | null | undefined, n = 4): string {
  if (!a) return '';
  return a.length <= n * 2 + 1 ? a : `${a.slice(0, n)}…${a.slice(-n)}`;
}

export function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}

export function dateShort(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function durationMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** Token amounts with decimals, as a readable string. */
export function tokenAmount(raw: string | bigint, decimals: number): string {
  const v = Number(BigInt(raw)) / 10 ** decimals;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return v.toFixed(v < 1 ? 4 : 2);
}

export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;
export const solscanAccount = (a: string) => `https://solscan.io/account/${a}`;
export const solscanToken = (a: string) => `https://solscan.io/token/${a}`;
export const pumpCoin = (mint: string) => `https://pump.fun/coin/${mint}`;
