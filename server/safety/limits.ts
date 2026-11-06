// Rate limits, AI spend caps and the switches an admin can throw.
import { kvGet, kvSet, today, type DB } from '../db';

/** Fixed-window counters per key, in memory. One process, so memory is the truth. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private now: () => number = Date.now) {}

  /** True when allowed. */
  take(key: string, limit: number, windowMs: number): boolean {
    const t = this.now();
    const cur = this.hits.get(key);
    if (!cur || cur.reset <= t) {
      this.hits.set(key, { n: 1, reset: t + windowMs });
      if (this.hits.size > 50_000) this.sweep();
      return true;
    }
    if (cur.n >= limit) return false;
    cur.n++;
    return true;
  }

  retryAfter(key: string): number {
    const cur = this.hits.get(key);
    return cur ? Math.max(1, Math.ceil((cur.reset - this.now()) / 1000)) : 1;
  }

  private sweep() {
    const t = this.now();
    for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
  }
}

export const LIMITS = {
  quotePerMin: 60,
  runPerMin: 30,
  authPerMin: 20,
  buildPerHour: 6,
  mcpPerMin: 120,
  readPerMin: 600,
  draftOpsPerMin: 30,
  concurrentRunsPerAgent: 4,
  concurrentRunsTotal: 12,
  maxBodyBytes: 64 * 1024,
};

/** Concurrency gates: how many paid runs may be in flight per agent and in total. */
export class Gates {
  private perAgent = new Map<string, number>();
  private total = 0;
  tryEnter(agentId: string): boolean {
    const n = this.perAgent.get(agentId) ?? 0;
    if (n >= LIMITS.concurrentRunsPerAgent || this.total >= LIMITS.concurrentRunsTotal) return false;
    this.perAgent.set(agentId, n + 1);
    this.total++;
    return true;
  }
  leave(agentId: string) {
    const n = this.perAgent.get(agentId) ?? 1;
    if (n <= 1) this.perAgent.delete(agentId);
    else this.perAgent.set(agentId, n - 1);
    this.total = Math.max(0, this.total - 1);
  }
  get inFlight() {
    return this.total;
  }
}

/** AI spend per UTC day, globally and per scope (an agent id or a draft id). */
export class SpendLedger {
  constructor(
    private db: DB,
    private globalCap: number,
    private agentCap: number,
  ) {}

  spent(scope: string, day = today()): number {
    const r = this.db.prepare('SELECT micros FROM ai_spend WHERE day = ? AND scope = ?').get(day, scope) as { micros: number } | undefined;
    return r?.micros ?? 0;
  }

  add(scope: string, micros: number) {
    if (micros <= 0) return;
    const day = today();
    const up = this.db.prepare('INSERT INTO ai_spend (day, scope, micros) VALUES (?, ?, ?) ON CONFLICT(day, scope) DO UPDATE SET micros = micros + excluded.micros');
    up.run(day, scope, micros);
    up.run(day, '*', micros);
  }

  /** Whether a further spend of up to `micros` fits under the global cap and this scope's cap. */
  room(scope: string, micros: number, scopeCap = this.agentCap): { ok: boolean; reason: string | null } {
    if (this.spent('*') + micros > this.globalCap) return { ok: false, reason: 'Fabrica has reached its AI spending limit for today. Calls open again after midnight UTC.' };
    if (this.spent(scope) + micros > scopeCap) return { ok: false, reason: 'This agent has reached its AI spending limit for today. It opens again after midnight UTC.' };
    return { ok: true, reason: null };
  }

  get caps() {
    return { global: this.globalCap, agent: this.agentCap };
  }
}

export interface Switches {
  callsPaused: boolean;
  buildsPaused: boolean;
}

export function readSwitches(db: DB): Switches {
  return { callsPaused: kvGet(db, 'switch:calls') === 'off', buildsPaused: kvGet(db, 'switch:builds') === 'off' };
}

export function setSwitch(db: DB, name: 'calls' | 'builds', on: boolean) {
  kvSet(db, `switch:${name}`, on ? 'on' : 'off');
}
