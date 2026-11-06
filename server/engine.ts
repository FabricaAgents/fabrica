// The one engine: every part of Fabrica wired together, and the read API the pages use in-process.
import { randomBytes } from 'node:crypto';
import { MODELS } from '../shared/models';
import type { AgentPublic, HolderTier, Receipt, SiteConfig, TestResult } from '../shared/types';
import { audit, kvGet, openDb, type DB } from './db';
import type { Config } from './config';
import type { Provider } from './ai/types';
import { FakeProvider } from './ai/fake';
import { OpenRouterProvider, refreshPrices } from './ai/openrouter';
import { AgentStore, type AgentRow, type SortKey } from './agents';
import { Drafts } from './drafts';
import { Payments } from './pay/payments';
import { receiptKeys, toReceipt, type ReceiptRow } from './pay/receipts';
import { Gates, RateLimiter, readSwitches, SpendLedger } from './safety/limits';
import { HttpRpc, type Rpc } from './solana/rpc';
import { FakeChain } from './solana/fake-chain';
import { FileStore } from './tools/files';
import { liveIO, type ToolIO } from './tools';
import { loadRecording, replayIO } from './tools/replay';
import { seedExamples } from './seed/examples';
import { exampleBrains } from '../fixtures/examples/index';
import { Calls } from './calls';
import { Coins } from './coins/coins';
import { TokenDesk } from './token/fabrica';
import { ChainStream } from './solana/stream';
import { Versions } from './versions';
import { Backups } from './backup';

export interface EngineOptions {
  cfg: Config;
  db?: DB;
  provider?: Provider | null;
  rpc?: Rpc;
  io?: ToolIO;
  log?: (m: string) => void;
  /** Skip example seeding and background loops (unit tests). */
  quiet?: boolean;
}

export class Engine {
  readonly cfg: Config;
  readonly db: DB;
  readonly rpc: Rpc;
  readonly files: FileStore;
  readonly payments: Payments;
  readonly agents: AgentStore;
  readonly drafts: Drafts;
  readonly ledger: SpendLedger;
  readonly limiter = new RateLimiter();
  readonly gates = new Gates();
  readonly calls: Calls;
  readonly coins: Coins;
  readonly token: TokenDesk;
  readonly stream: ChainStream | null;
  readonly receiptKeys;
  readonly versions: Versions;
  readonly backups: Backups;
  readonly startedAt = Date.now();
  readonly log: (m: string) => void;
  provider: Provider | null;
  io: ToolIO;
  seeded = false;
  seedError: string | null = null;
  private timers: NodeJS.Timeout[] = [];
  private quiet: boolean;

  constructor(o: EngineOptions) {
    this.cfg = o.cfg;
    this.log = o.log ?? ((m) => console.log(`[fabrica] ${m}`));
    this.quiet = Boolean(o.quiet);
    this.db = o.db ?? openDb(o.cfg.dataDir);
    this.rpc = o.rpc ?? (o.cfg.testMode ? new FakeChain(o.cfg.usdcMint) : new HttpRpc(o.cfg.rpcUrls, fetch, 10_000, o.cfg.backupRpc));
    this.files = new FileStore(this.db, o.cfg.dataDir, o.cfg.siteUrl);
    this.provider =
      o.provider !== undefined
        ? o.provider
        : o.cfg.aiMode === 'openrouter'
          ? new OpenRouterProvider(o.cfg.openrouterKey!, o.cfg.openrouterBase, o.cfg.siteUrl)
          : o.cfg.aiMode === 'fake'
            ? new FakeProvider(exampleBrains())
            : null;
    // Recorded reads in fake mode, so a local build never depends on the network; live reads otherwise.
    this.io = o.io ?? (o.cfg.aiMode === 'fake' ? { ...replayIO(loadRecording(o.cfg.fixturesDir)), rpc: this.rpc } : liveIO(this.rpc));
    this.ledger = new SpendLedger(this.db, o.cfg.dailyAiCapMicros, o.cfg.agentDailyAiCapMicros);
    this.payments = new Payments(this.db, o.cfg, this.rpc);
    this.token = new TokenDesk(this);
    this.agents = new AgentStore(this.db, o.cfg, (w) => this.token.cachedTier(w));
    this.drafts = new Drafts({ db: this.db, provider: () => this.requireProvider(), io: () => this.io, files: this.files, ledger: this.ledger });
    this.receiptKeys = receiptKeys(this.db);
    // Test reports are signed with the receipt key, so one public key checks both.
    this.versions = new Versions(this.db, this.receiptKeys, o.cfg.siteUrl);
    this.agents.versions = this.versions;
    this.backups = new Backups(this.db, o.cfg.dataDir, this.log);
    this.calls = new Calls(this);
    this.coins = new Coins(this);
    this.stream = o.cfg.testMode || this.quiet ? null : new ChainStream(this);
  }

  requireProvider(): Provider {
    if (!this.provider) throw new Error('The builder is offline: no AI provider is configured.');
    return this.provider;
  }

  async start() {
    this.drafts.recover();
    // Agents from before versions get their version record and a signed report from their existing test run.
    this.versions.ensureAll();
    if (!this.quiet) {
      void this.seed();
      if (this.cfg.aiMode === 'openrouter') {
        refreshPrices(MODELS, this.cfg.openrouterBase)
          .then((n) => this.log(`model prices refreshed for ${n} models`))
          .catch((e) => this.log(`model prices: kept the built-in table (${(e as Error).message})`));
      }
      this.every(10 * 60_000, () => {
        this.payments.sweep();
        this.files.sweep();
        this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
        this.db.prepare('DELETE FROM auth_nonces WHERE created_at < ?').run(Date.now() - 15 * 60_000);
      });
      this.every(2 * 60_000, () => this.coins.refreshCurves());
      this.every(60 * 60_000, () => this.token.burnTick());
      // A snapshot of the database once a day; the check runs hourly and a few minutes after a start.
      this.every(60 * 60_000, () => this.backups.due());
      const first = setTimeout(() => {
        try {
          this.backups.due();
        } catch (e) {
          this.log(`backup failed: ${(e as Error).message}`);
        }
      }, 3 * 60_000);
      first.unref();
      this.timers.push(first);
      this.stream?.start();
    }
  }

  private every(ms: number, fn: () => unknown) {
    const t = setInterval(() => {
      Promise.resolve()
        .then(fn)
        .catch((e) => this.log(`background job failed: ${(e as Error).message}`));
    }, ms);
    t.unref();
    this.timers.push(t);
  }

  async seed(force = false) {
    try {
      await seedExamples(this.db, this.files, this.cfg.fixturesDir, this.log, force);
      this.versions.ensureAll();
      this.seeded = true;
    } catch (e) {
      this.seedError = (e as Error).message;
      this.log(`examples could not be built: ${this.seedError}`);
    }
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.stream?.stop();
    await this.calls.drain(8000);
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ------------------------------------------------------------------ config the pages and client read

  siteConfig(): SiteConfig {
    const sw = readSwitches(this.db);
    const buildClosedReason = sw.buildsPaused
      ? 'Building is paused for maintenance. Drafts you already paid for keep working.'
      : !this.provider
        ? 'The builder opens soon.'
        : !this.cfg.opsWallet
          ? 'The builder opens soon.'
          : null;
    return {
      siteUrl: this.cfg.siteUrl,
      xUrl: this.cfg.xUrl,
      mint: this.cfg.mint,
      usdcMint: this.cfg.usdcMint,
      network: this.cfg.network,
      buildFee: this.cfg.buildFeeMicros,
      buildOpen: buildClosedReason === null,
      buildClosedReason,
      remixOpen: this.cfg.remixOpen,
      versionsOpen: this.cfg.versionsOpen,
      payOpen: this.payments.open && !sw.callsPaused,
      aiMode: this.cfg.aiMode,
      testMode: this.cfg.testMode,
      tiers: this.cfg.mint ? this.cfg.tiers : null,
      baseTier: this.cfg.baseTier,
    };
  }

  // ------------------------------------------------------------------ reads

  listAgents(opts: { sort?: SortKey; q?: string; tool?: string; category?: string } = {}): AgentPublic[] {
    return this.agents.list(opts);
  }

  agent(slug: string): AgentPublic | null {
    const r = this.agents.row(slug);
    return r && r.status !== 'retired' ? this.agents.toPublic(r) : null;
  }

  agentRow(slug: string): AgentRow | null {
    return this.agents.row(slug);
  }

  /** The live and paused remixes of an agent, newest first. */
  remixesOf(slug: string): AgentPublic[] {
    const r = this.agents.row(slug);
    return r ? this.agents.remixRows(r.id).map((x) => this.agents.toPublic(x)) : [];
  }

  agentTests(slug: string): TestResult[] {
    const r = this.agents.row(slug);
    return r ? this.agents.testResults(r) : [];
  }

  receipts(slug: string, limit = 25, before?: number): Receipt[] {
    const r = this.agents.row(slug);
    if (!r) return [];
    const rows = this.db.prepare('SELECT * FROM receipts WHERE agent_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?').all(r.id, before ?? Number.MAX_SAFE_INTEGER, Math.min(limit, 100)) as unknown as ReceiptRow[];
    return rows.map((x) => toReceipt(x, r.slug));
  }

  receipt(id: string): Receipt | null {
    const row = this.db.prepare('SELECT * FROM receipts WHERE id = ?').get(id) as ReceiptRow | undefined;
    if (!row) return null;
    const a = this.db.prepare('SELECT slug FROM agents WHERE id = ?').get(row.agent_id) as { slug: string } | undefined;
    return toReceipt(row, a?.slug ?? '');
  }

  /** Daily paid calls and revenue for one agent, for its earnings chart. */
  earningsSeries(slug: string, days = 30): { day: string; calls: number; revenue: number }[] {
    const r = this.agents.row(slug);
    if (!r) return [];
    const since = Date.now() - days * 86_400_000;
    const rows = this.db.prepare("SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS calls, SUM(total) AS revenue FROM receipts WHERE agent_id = ? AND created_at >= ? GROUP BY day ORDER BY day").all(r.id, since) as { day: string; calls: number; revenue: number }[];
    const map = new Map(rows.map((x) => [x.day, x]));
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      out.push(map.get(day) ?? { day, calls: 0, revenue: 0 });
    }
    return out;
  }

  totals() {
    const r = this.db.prepare("SELECT COUNT(*) AS calls, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(maker_amt),0) AS makers, COUNT(DISTINCT payer) AS buyers FROM receipts").get() as { calls: number; revenue: number; makers: number; buyers: number };
    const agents = this.db.prepare("SELECT COUNT(*) AS n FROM agents WHERE status IN ('live','paused')").get() as { n: number };
    const tests = this.db.prepare("SELECT COALESCE(SUM(total),0) AS n FROM test_runs WHERE status = 'done'").get() as { n: number };
    return { ...r, liveAgents: agents.n, testsRun: tests.n };
  }

  tierFor(wallet: string | null): HolderTier {
    return this.token.cachedTier(wallet) ?? this.cfg.baseTier;
  }

  newId(prefix: string) {
    return `${prefix}_${randomBytes(9).toString('base64url')}`;
  }

  // ------------------------------------------------------------------ admin

  setAgentPaused(slug: string, paused: boolean, reason: string | null, actor: string): AgentPublic {
    const r = this.agents.row(slug);
    if (!r || r.example) throw new Error('no such agent');
    this.db.prepare('UPDATE agents SET status = ?, pause_reason = ?, updated_at = ? WHERE id = ?').run(paused ? 'paused' : 'live', paused ? (reason ?? 'Paused') : null, Date.now(), r.id);
    audit(this.db, actor, paused ? 'pause' : 'resume', { agent: r.slug, reason });
    return this.agent(r.slug)!;
  }

  health() {
    const sw = readSwitches(this.db);
    let dbOk = true;
    try {
      this.db.prepare('SELECT 1').get();
    } catch {
      dbOk = false;
    }
    return {
      ok: dbOk,
      uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      db: dbOk ? 'ok' : 'failing',
      ai: this.cfg.aiMode,
      examples: this.seeded ? 'built' : this.seedError ? `failed: ${this.seedError}` : 'building',
      payments: this.payments.open ? 'open' : 'closed: set FABRICA_OPS_WALLET and FABRICA_BURN_WALLET',
      switches: { calls: sw.callsPaused ? 'paused' : 'on', builds: sw.buildsPaused ? 'paused' : 'on', remix: this.cfg.remixOpen ? 'on' : 'off', versions: this.cfg.versionsOpen ? 'on' : 'off' },
      backup: this.backups.health(),
      rpc: this.rpc.label,
      rpcNodes: this.rpc instanceof HttpRpc ? this.rpc.stats.map((s, i) => ({ node: i, ok: s.ok, fail: s.fail, lastError: s.lastError })) : null,
      stream: this.stream?.status() ?? 'off',
      token: this.cfg.mint ? 'launched' : 'not launched',
      burnKeeper: this.token.status(),
      inFlight: this.gates.inFlight,
      aiSpendToday: { micros: this.ledger.spent('*'), capMicros: this.ledger.caps.global },
    };
  }
}
