// JSON-RPC to Solana with failover across the free nodes. A backup node (Helius, when a key is set) is tried only
// after every free node failed the call, and never becomes the preferred node, so its credits are spent rarely.
export interface Rpc {
  readonly label: string;
  call<T = any>(method: string, params?: unknown[]): Promise<T>;
}

export class RpcError extends Error {
  constructor(
    message: string,
    public code: number | null,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export class HttpRpc implements Rpc {
  private preferred = 0;
  private seq = 0;
  readonly label: string;
  /** Health counters for /api/health, by node index. */
  readonly stats: { ok: number; fail: number; lastError: string | null; lastOkAt: number | null }[];

  private free: number;

  constructor(
    private urls: string[],
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs = 10_000,
    backup: string | null = null,
  ) {
    if (!urls.length) throw new Error('no RPC URLs');
    this.free = urls.length;
    this.urls = backup ? [...urls, backup] : urls;
    this.label = this.urls.map((u, i) => (i >= this.free ? 'helius (backup)' : u.includes('helius') ? 'helius' : new URL(u).hostname)).join(' > ');
    this.stats = this.urls.map(() => ({ ok: 0, fail: 0, lastError: null, lastOkAt: null }));
  }

  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    let lastErr: unknown = null;
    for (let i = 0; i < this.urls.length; i++) {
      // Free nodes in turn from the last one that worked, then the backup last.
      const idx = i < this.free ? (this.preferred + i) % this.free : i;
      try {
        const res = await this.fetchImpl(this.urls[idx], {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.seq, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500 || res.status === 403) throw new RpcError(`node answered ${res.status}`, res.status);
        const j: any = await res.json();
        if (j.error) {
          // A real answer from a healthy node: do not fail over, the next node would say the same.
          this.stats[idx].ok++;
          throw Object.assign(new RpcError(String(j.error.message ?? 'rpc error'), Number(j.error.code) || null), { final: true });
        }
        this.stats[idx].ok++;
        this.stats[idx].lastOkAt = Date.now();
        if (idx < this.free) this.preferred = idx;
        return j.result as T;
      } catch (e) {
        if ((e as { final?: boolean }).final) throw e;
        this.stats[idx].fail++;
        this.stats[idx].lastError = String((e as Error)?.message ?? e).slice(0, 160);
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new RpcError('every node failed', null);
  }
}

/** A real Solana signature is 64 bytes of base58. Simulated transactions in logsSubscribe come signed with all 1s. */
export function isSimulatedSignature(sig: string): boolean {
  return /^1+$/.test(sig);
}

export const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
export const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
