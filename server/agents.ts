// Agents as the site and the API see them: the spec, the price, the test record, real earnings and the coin.
import type { AgentPublic, AgentSpec, AgentStats, CoinInfo, HolderTier, RemixParent, TestResult, TestRunSummary, ToolName } from '../shared/types';
import type { DB } from './db';
import { priceFor, type FeeRules } from './pay/price';
import type { Versions } from './versions';
import type { Networks } from './networks';

export interface AgentRow {
  id: string;
  slug: string;
  maker: string | null;
  status: AgentPublic['status'];
  example: number;
  spec: string;
  version: number;
  test_run_id: string | null;
  draft_id: string | null;
  published_at: number;
  updated_at: number;
  pause_reason: string | null;
  coin_mint: string | null;
  coin_symbol: string | null;
  coin_name: string | null;
  coin_launch_sig: string | null;
  coin_launched_at: number | null;
  coin_curve: string | null;
  buyback_bps: number;
  has_image: number;
  sentence: string | null;
  /** The agent this one was remixed from. Set by the server at publish, never edited afterwards. */
  parent_id: string | null;
  royalty_bps: number;
  /** The lowest maker part a remix may charge: the original's at the time the remix went live. */
  fee_floor: number;
}

export interface TestRunRow {
  id: string;
  draft_id: string | null;
  agent_id: string | null;
  spec_hash: string;
  model: string;
  status: string;
  total: number;
  passed: number;
  safety_total: number;
  safety_passed: number;
  task_total: number;
  task_passed: number;
  score: number;
  publishable: number;
  results: string;
  ai_cost: number;
  started_at: number;
  finished_at: number | null;
}

export const EMPTY_STATS: AgentStats = { paidCalls: 0, revenueMicros: 0, makerEarnedMicros: 0, royaltyPaidMicros: 0, buyers: 0, repeatBuyers: 0, okCalls: 0, failedCalls: 0, avgMs: 0, last24hCalls: 0 };

export function runSummary(r: TestRunRow): TestRunSummary {
  return {
    id: r.id,
    total: r.total,
    passed: r.passed,
    safetyTotal: r.safety_total,
    safetyPassed: r.safety_passed,
    taskTotal: r.task_total,
    taskPassed: r.task_passed,
    score: r.score,
    publishable: Boolean(r.publishable),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    aiCostMicros: r.ai_cost,
    model: r.model,
  };
}

export type SortKey = 'revenue' | 'calls' | 'pass' | 'repeat' | 'new';

export class AgentStore {
  /** Set by the engine: the version record and signed reports. */
  versions: Versions | null = null;
  /** Set by the engine: hire lists, plans and receipt trees. */
  networks: Networks | null = null;
  constructor(
    private db: DB,
    private fees: FeeRules,
    private tierOf: (wallet: string | null) => HolderTier | null = () => null,
  ) {}

  row(slugOrId: string): AgentRow | null {
    return (this.db.prepare('SELECT * FROM agents WHERE slug = ? OR id = ?').get(slugOrId, slugOrId) as AgentRow | undefined) ?? null;
  }

  spec(row: AgentRow): AgentSpec {
    return JSON.parse(row.spec) as AgentSpec;
  }

  testRun(id: string | null): TestRunRow | null {
    if (!id) return null;
    return (this.db.prepare('SELECT * FROM test_runs WHERE id = ?').get(id) as TestRunRow | undefined) ?? null;
  }

  testResults(row: AgentRow): TestResult[] {
    const r = this.testRun(row.test_run_id);
    return r ? (JSON.parse(r.results) as TestResult[]) : [];
  }

  private allStats(): Map<string, AgentStats> {
    const out = new Map<string, AgentStats>();
    const day = Date.now() - 86_400_000;
    const rows = this.db
      .prepare(
        `SELECT agent_id, COUNT(*) AS paid, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(maker_amt),0) AS maker,
          COUNT(DISTINCT payer) AS buyers, SUM(CASE WHEN status != 'failed' THEN 1 ELSE 0 END) AS ok,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, COALESCE(AVG(ms),0) AS avg_ms,
          SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS recent, COALESCE(SUM(royalty_amt),0) AS royalty
         FROM receipts r WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = r.agent_id AND a.maker = r.payer) GROUP BY agent_id`,
      )
      .all(day) as any[];
    const repeat = this.db.prepare('SELECT agent_id, COUNT(*) AS n FROM (SELECT r.agent_id, r.payer FROM receipts r JOIN agents a ON a.id = r.agent_id WHERE a.maker IS NOT r.payer GROUP BY r.agent_id, r.payer HAVING COUNT(*) > 1) GROUP BY agent_id').all() as { agent_id: string; n: number }[];
    const rep = new Map(repeat.map((r) => [r.agent_id, r.n]));
    for (const r of rows) {
      out.set(r.agent_id, {
        paidCalls: r.paid,
        revenueMicros: r.revenue,
        makerEarnedMicros: r.maker,
        royaltyPaidMicros: r.royalty,
        buyers: r.buyers,
        repeatBuyers: rep.get(r.agent_id) ?? 0,
        okCalls: r.ok,
        failedCalls: r.failed,
        avgMs: Math.round(r.avg_ms),
        last24hCalls: r.recent,
      });
    }
    return out;
  }

  stats(agentId: string): AgentStats {
    return this.allStats().get(agentId) ?? EMPTY_STATS;
  }

  coin(row: AgentRow): CoinInfo | null {
    if (!row.coin_mint) return null;
    const since = row.coin_launched_at ?? 0;
    const setAside = (this.db.prepare('SELECT COALESCE(SUM(maker_amt * buyback_bps / 10000), 0) AS v FROM receipts WHERE agent_id = ? AND status != ? AND created_at >= ?').get(row.id, 'failed', since) as { v: number }).v;
    const spent = (this.db.prepare('SELECT COALESCE(SUM(usdc_spent),0) AS v, COUNT(*) AS n FROM buys WHERE agent_id = ? AND kind = ?').get(row.id, 'agent') as { v: number; n: number });
    const burned = this.db.prepare('SELECT tokens_burned FROM burns WHERE agent_id = ? AND kind = ?').all(row.id, 'agent') as { tokens_burned: string }[];
    return {
      mint: row.coin_mint,
      symbol: row.coin_symbol ?? '',
      name: row.coin_name ?? '',
      launchedAt: row.coin_launched_at ?? 0,
      launchSig: row.coin_launch_sig ?? '',
      buybackBps: row.buyback_bps,
      setAsideMicros: Math.floor(setAside),
      spentMicros: spent.v,
      burnedRaw: burned.reduce((n, b) => n + BigInt(b.tokens_burned), 0n).toString(),
      burns: burned.length,
      curve: row.coin_curve ? JSON.parse(row.coin_curve) : null,
    };
  }

  /** Who a remix pays its royalty to. None for an original, a remix of an example, or a maker's remix of their own agent. */
  royalty(row: AgentRow): { bps: number; wallet: string | null; parent: AgentRow | null } {
    const parent = row.parent_id ? this.row(row.parent_id) : null;
    if (!parent || !row.royalty_bps || !parent.maker || parent.maker === row.maker) return { bps: 0, wallet: null, parent };
    return { bps: row.royalty_bps, wallet: parent.maker, parent };
  }

  parentOf(row: AgentRow): RemixParent | null {
    const p = row.parent_id ? this.row(row.parent_id) : null;
    if (!p) return null;
    return { slug: p.slug, name: this.spec(p).name, maker: p.maker, example: Boolean(p.example) };
  }

  /** Live and paused remixes of an agent, newest first. */
  remixRows(parentId: string): AgentRow[] {
    return this.db.prepare("SELECT * FROM agents WHERE parent_id = ? AND status IN ('live','paused') ORDER BY published_at DESC").all(parentId) as unknown as AgentRow[];
  }

  /**
   * Royalties an agent's remixes paid its maker. Calls by the remix's own maker or by the original's maker are left
   * out, the same way a maker's calls to their own agent never count, so nobody can pump the number in a circle.
   */
  royaltiesPaid(parentId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(r.royalty_amt), 0) AS v FROM receipts r JOIN agents x ON x.id = r.agent_id JOIN agents p ON p.id = x.parent_id
           WHERE x.parent_id = ? AND r.payer IS NOT x.maker AND r.payer IS NOT p.maker`,
        )
        .get(parentId) as { v: number }
    ).v;
  }

  /** How many live remixes this maker already has of one agent. */
  remixCountBy(parentId: string, wallet: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM agents WHERE parent_id = ? AND maker = ? AND status IN ('live','paused')").get(parentId, wallet) as { n: number }).n;
  }

  /** The agent's ancestors, nearest first. Lineage is short; the walk stops at 20 in any case. */
  lineage(row: AgentRow): AgentRow[] {
    const out: AgentRow[] = [];
    let cur = row.parent_id ? this.row(row.parent_id) : null;
    while (cur && out.length < 20 && !out.some((x) => x.id === cur!.id)) {
      out.push(cur);
      cur = cur.parent_id ? this.row(cur.parent_id) : null;
    }
    return out;
  }

  toPublic(row: AgentRow, stats?: AgentStats): AgentPublic {
    const spec = this.spec(row);
    const tr = this.testRun(row.test_run_id);
    const royalty = this.royalty(row);
    const price = priceFor(spec, this.fees, this.tierOf(row.maker), royalty.bps);
    // An agent that hires: the price is one call of it plus every hire slot of a run, as the quote will ask.
    const network = this.networks?.publicOf(row) ?? null;
    if (network && !network.problem) {
      price.hires = network.hiresTotal;
      price.total += network.hiresTotal;
    }
    return {
      id: row.id,
      slug: row.slug,
      status: row.status,
      example: Boolean(row.example),
      maker: row.maker,
      sentence: row.sentence,
      name: spec.name,
      tagline: spec.tagline,
      brief: spec.brief,
      category: spec.category,
      model: spec.model,
      tools: Object.keys(spec.tools) as ToolName[],
      toolConfig: spec.tools,
      input: spec.input,
      output: spec.output,
      examples: spec.examples,
      price,
      publishedAt: row.published_at,
      version: row.version,
      pauseReason: row.pause_reason,
      tests: tr ? runSummary(tr) : null,
      stats: stats ?? this.stats(row.id),
      coin: this.coin(row),
      remixOf: this.parentOf(row),
      royaltyBps: royalty.bps,
      remixes: { count: this.remixRows(row.id).length, royaltiesMicros: this.royaltiesPaid(row.id) },
      ...this.versionInfo(row),
      network,
      hiredBy: this.networks?.hiredBy(row) ?? [],
      hireEarnings: this.networks?.hireEarnings(row) ?? { slots: 0, calls: 0, makerMicros: 0 },
    };
  }

  private versionInfo(row: AgentRow): Pick<AgentPublic, 'versionCount' | 'report'> {
    const v = this.versions;
    if (!v) return { versionCount: 1, report: null };
    // An agent that predates versions (or was written straight into the table) gets its record on first read.
    if (!v.count(row.id)) v.ensure(row);
    return { versionCount: v.count(row.id), report: v.report(row, row.version) };
  }

  list(opts: { sort?: SortKey; q?: string; tool?: string; category?: string; includeRetired?: boolean } = {}): AgentPublic[] {
    const rows = this.db.prepare(`SELECT * FROM agents ${opts.includeRetired ? '' : "WHERE status != 'retired'"}`).all() as unknown as AgentRow[];
    const stats = this.allStats();
    let list = rows.map((r) => this.toPublic(r, stats.get(r.id) ?? EMPTY_STATS));
    if (opts.q) {
      const q = opts.q.toLowerCase().slice(0, 80);
      list = list.filter((a) => `${a.name} ${a.tagline} ${a.brief} ${a.category}`.toLowerCase().includes(q));
    }
    if (opts.tool) list = list.filter((a) => a.tools.includes(opts.tool as ToolName));
    if (opts.category) list = list.filter((a) => a.category === opts.category);
    return rank(list, opts.sort ?? 'revenue');
  }

  byMaker(wallet: string): AgentPublic[] {
    const rows = this.db.prepare('SELECT * FROM agents WHERE maker = ? ORDER BY published_at DESC').all(wallet) as unknown as AgentRow[];
    return rows.map((r) => this.toPublic(r));
  }

  liveCountFor(wallet: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM agents WHERE maker = ? AND status IN ('live','paused')").get(wallet) as { n: number }).n;
  }
}

/** Real earnings first (a maker's calls to their own agent never count): revenue, then paid calls, then repeat buyers, then test score. Examples always last. */
export function rank(list: AgentPublic[], sort: SortKey): AgentPublic[] {
  const key: Record<SortKey, (a: AgentPublic) => number[]> = {
    revenue: (a) => [a.stats.revenueMicros, a.stats.paidCalls, a.stats.repeatBuyers, a.tests?.score ?? 0],
    calls: (a) => [a.stats.paidCalls, a.stats.revenueMicros, a.tests?.score ?? 0],
    pass: (a) => [a.tests?.score ?? 0, a.tests?.safetyPassed ?? 0, a.stats.paidCalls],
    repeat: (a) => [a.stats.repeatBuyers, a.stats.buyers, a.stats.paidCalls],
    new: (a) => [a.publishedAt],
  };
  const k = key[sort] ?? key.revenue;
  return [...list].sort((a, b) => {
    if (a.example !== b.example) return a.example ? 1 : -1;
    if ((a.status === 'live') !== (b.status === 'live')) return a.status === 'live' ? -1 : 1;
    const ka = k(a);
    const kb = k(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return a.name.localeCompare(b.name);
  });
}
