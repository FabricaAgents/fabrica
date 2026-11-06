// Live chain events for agent coins: one logsSubscribe per coin mint. Every notification triggers a fresh read
// of the coin's curve (debounced). Simulated transactions also arrive here, signed all 1s; they are dropped.
import type { Engine } from '../engine';
import { isSimulatedSignature } from './rpc';

const MAX_SUBS = 40;

export class ChainStream {
  private ws: WebSocket | null = null;
  private subs = new Map<number, string>();
  private pendingReq = new Map<number, string>();
  private watched = new Set<string>();
  private seq = 0;
  private backoff = 2000;
  private stopped = false;
  private debounce = new Map<string, NodeJS.Timeout>();
  stats = { events: 0, simulatedDropped: 0, reconnects: 0, connected: false };

  constructor(private e: Engine) {}

  status(): string {
    if (!this.watched.size) return 'idle: no coins yet';
    return `${this.stats.connected ? 'connected' : 'reconnecting'}, ${this.subs.size} coins, ${this.stats.events} events, ${this.stats.simulatedDropped} simulated dropped`;
  }

  start() {
    const rows = this.e.db.prepare('SELECT coin_mint FROM agents WHERE coin_mint IS NOT NULL LIMIT ?').all(MAX_SUBS) as { coin_mint: string }[];
    for (const r of rows) this.watched.add(r.coin_mint);
    if (this.watched.size) this.connect();
  }

  watch(mint: string) {
    if (this.watched.has(mint) || this.watched.size >= MAX_SUBS) return;
    this.watched.add(mint);
    if (!this.ws) this.connect();
    else if (this.ws.readyState === WebSocket.OPEN) this.subscribe(mint);
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
    for (const t of this.debounce.values()) clearTimeout(t);
  }

  private subscribe(mint: string) {
    const id = ++this.seq;
    this.pendingReq.set(id, mint);
    this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [mint] }, { commitment: 'confirmed' }] }));
  }

  private connect() {
    if (this.stopped || !this.e.cfg.wsUrl) return;
    try {
      this.ws = new WebSocket(this.e.cfg.wsUrl);
    } catch {
      return this.retry();
    }
    const ping = setInterval(() => this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++this.seq, method: 'getHealth' })), 30_000);
    this.ws.onopen = () => {
      this.stats.connected = true;
      this.backoff = 2000;
      this.subs.clear();
      for (const m of this.watched) this.subscribe(m);
    };
    this.ws.onmessage = (ev) => this.onMessage(String(ev.data));
    this.ws.onclose = () => {
      clearInterval(ping);
      this.stats.connected = false;
      this.ws = null;
      this.retry();
    };
    this.ws.onerror = () => this.ws?.close();
  }

  private retry() {
    if (this.stopped) return;
    this.stats.reconnects++;
    setTimeout(() => this.connect(), this.backoff).unref();
    this.backoff = Math.min(this.backoff * 2, 60_000);
  }

  /** Exported for tests: handles one raw message. */
  onMessage(raw: string) {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.id && this.pendingReq.has(m.id) && typeof m.result === 'number') {
      this.subs.set(m.result, this.pendingReq.get(m.id)!);
      this.pendingReq.delete(m.id);
      return;
    }
    if (m.method !== 'logsNotification') return;
    const sig = String(m.params?.result?.value?.signature ?? '');
    if (!sig || isSimulatedSignature(sig)) {
      this.stats.simulatedDropped++;
      return;
    }
    if (m.params?.result?.value?.err) return;
    const mint = this.subs.get(m.params?.subscription);
    if (!mint) return;
    this.stats.events++;
    clearTimeout(this.debounce.get(mint));
    this.debounce.set(
      mint,
      setTimeout(() => {
        this.debounce.delete(mint);
        void this.e.coins.refreshCurve(mint).catch(() => {});
      }, 4000),
    );
  }
}
