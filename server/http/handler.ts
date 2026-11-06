// Fabrica's HTTP surface in front of the pages: the JSON API, x402 paid calls, MCP, files, coin metadata, admin.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import type { Engine } from '../engine';
import { audit, kvGet, kvSet } from '../db';
import { Auth, adminOk } from './auth';
import { LIMITS, setSwitch } from '../safety/limits';
import { checkSentence } from '../spec/generate';
import { SpecError } from '../spec/schema';
import { CoinError } from '../coins/coins';
import { PaymentError } from '../pay/verify';
import { handleMcp } from '../mcp/mcp';
import { MIME } from '../tools/files';
import { FakeChain } from '../solana/fake-chain';
import { MAX_RUNS_PER_FEE } from '../drafts';
import type { AgentSpec } from '../../shared/types';
import type { AgentRow, SortKey } from '../agents';
import { priceFor } from '../pay/price';
import { RECEIPT_FORMATS } from '../pay/receipts';
import { copiedFrom, remixProblems, remixRefusal } from '../remix';
import { TEST_REPORT_FORMAT, VersionError, versionProblems, versionRefusal } from '../versions';
import { reportMessage, VERSION_LIMITS } from '../../shared/versions';
import fs from 'node:fs';
import { tx } from '../db';

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'error',
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function clientIp(req: IncomingMessage, hops: number): string {
  const xf = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (hops > 0 && xf.length >= hops) return xf[xf.length - hops];
  return req.socket.remoteAddress ?? 'unknown';
}

const OPEN_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, x-payment, payment-signature, x-fabrica-retry, mcp-protocol-version, mcp-session-id',
  'access-control-expose-headers': 'x-payment-response, payment-response',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

export function createHandler(e: Engine) {
  const auth = new Auth(e.db, e.cfg.siteUrl);
  const secure = e.cfg.siteUrl.startsWith('https://');
  const siteOrigin = new URL(e.cfg.siteUrl).origin;

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(body === null ? '' : JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<any> =>
    new Promise((resolve, reject) => {
      let size = 0;
      let tooBig = false;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > LIMITS.maxBodyBytes) {
          // Stop keeping it but let the rest drain, so the 413 reaches the caller.
          if (!tooBig) reject(new HttpError(413, 'The request body is too large.'));
          tooBig = true;
          chunks.length = 0;
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return;
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HttpError(400, 'The body is not JSON.'));
        }
      });
      req.on('error', reject);
    });

  const limit = (key: string, n: number, windowMs: number) => {
    if (!e.limiter.take(key, n, windowMs)) throw new HttpError(429, 'Too many requests. Slow down a little.', 'rate_limited');
  };

  /** Cookie-authenticated writes must come from Fabrica's own pages. */
  const sameOrigin = (req: IncomingMessage) => {
    const o = req.headers.origin ?? (req.headers.referer ? new URL(String(req.headers.referer)).origin : null);
    if (o && o !== siteOrigin && !e.cfg.dev) throw new HttpError(403, 'Cross-site request refused.');
  };

  const maker = (req: IncomingMessage): string => {
    const w = auth.wallet(req.headers.cookie);
    if (!w) throw new HttpError(401, 'Connect your wallet and sign in first.', 'signin');
    return w;
  };

  const ownDraft = (id: string, wallet: string) => {
    const d = e.drafts.row(id);
    if (!d || d.maker !== wallet) throw new HttpError(404, 'No such draft.');
    return d;
  };

  const agentSpecOf = (slug: string, wallet: string) => {
    const row = e.agents.row(slug);
    if (!row || row.example || row.maker !== wallet) throw new HttpError(404, 'No such agent of yours.');
    return row;
  };

  const buildRoom = () => {
    const c = e.siteConfig();
    if (!c.buildOpen) throw new HttpError(503, c.buildClosedReason ?? 'Building is closed.', 'closed');
  };

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://local');
    const p = url.pathname;
    const m = req.method ?? 'GET';
    const ip = clientIp(req, e.cfg.trustProxyHops);
    const isApi = p.startsWith('/api/') || p === '/mcp' || p.startsWith('/mcp/') || p.startsWith('/files/') || p.startsWith('/coin-meta/');
    if (!isApi) return false;
    const open = p === '/mcp' || p.startsWith('/mcp/') || /^\/api\/agents\/[^/]+\/run$/.test(p) || (m === 'GET' && (p.startsWith('/api/agents') || p.startsWith('/api/receipts') || p === '/api/health' || p === '/api/x402'));
    const cors = open ? OPEN_CORS : {};
    if (m === 'OPTIONS') {
      res.writeHead(open ? 204 : 403, cors);
      res.end();
      return true;
    }
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => send(res, status, body, { ...cors, ...headers });
    try {
      if (!e.limiter.take(`read:${ip}`, LIMITS.readPerMin, 60_000)) throw new HttpError(429, 'Too many requests. Slow down a little.', 'rate_limited');

      // ---------------------------------------------------------------- health and config
      if (p === '/api/health' && m === 'GET') {
        const h = e.health();
        json(h.ok ? 200 : 503, h);
        return true;
      }
      if (p === '/api/config' && m === 'GET') return json(200, e.siteConfig()), true;
      if (p === '/api/chain/blockhash' && m === 'GET') {
        limit(`bh:${ip}`, 60, 60_000);
        const r = await e.rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }]);
        return json(200, { blockhash: r.value.blockhash, lastValidBlockHeight: r.value.lastValidBlockHeight }), true;
      }

      // ---------------------------------------------------------------- sign-in
      if (p === '/api/auth/nonce' && m === 'POST') {
        limit(`auth:${ip}`, LIMITS.authPerMin, 60_000);
        const b = await readBody(req);
        try {
          return json(200, auth.nonce(String(b.wallet ?? ''))), true;
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
      }
      if (p === '/api/auth/verify' && m === 'POST') {
        limit(`auth:${ip}`, LIMITS.authPerMin, 60_000);
        sameOrigin(req);
        const b = await readBody(req);
        let cookie: string;
        try {
          cookie = auth.verify(String(b.wallet ?? ''), String(b.nonce ?? ''), String(b.message ?? ''), String(b.signature ?? ''));
        } catch (err) {
          throw new HttpError(401, (err as Error).message, 'signin');
        }
        return json(200, { wallet: b.wallet }, { 'set-cookie': auth.cookie(cookie, secure) }), true;
      }
      if (p === '/api/auth/logout' && m === 'POST') {
        auth.logout(req.headers.cookie);
        return json(200, { ok: true }, { 'set-cookie': auth.clearCookie(secure) }), true;
      }
      if (p === '/api/me' && m === 'GET') {
        const w = auth.wallet(req.headers.cookie);
        if (!w) return json(200, { wallet: null }), true;
        const tier = await e.token.tierFor(w).catch(() => e.cfg.baseTier);
        return json(200, { wallet: w, tier, agents: e.agents.byMaker(w), drafts: e.drafts.forMaker(w).map((d) => ({ id: d.id, sentence: d.sentence, status: d.status, name: d.spec ? JSON.parse(d.spec).name : null, updatedAt: d.updated_at })) }), true;
      }

      // ---------------------------------------------------------------- build (paid per draft)
      if (p === '/api/build' && m === 'POST') {
        const w = maker(req);
        sameOrigin(req);
        buildRoom();
        const b = await readBody(req);
        let sentence: string;
        let from: { id: string; spec: AgentSpec; tests: any[] } | undefined;
        let parent: AgentRow | null = null;
        const header = String(req.headers['x-payment'] ?? req.headers['payment-signature'] ?? '') || undefined;
        if (b.remixOf) {
          // A remix: any live agent or example, one sentence. The rules are checked before the quote, so nobody pays
          // for a refusal; a payment already made for a quote is honoured even if the switch was turned off since.
          parent = e.agents.row(String(b.remixOf).slice(0, 60));
          if (!header) {
            if (!e.cfg.remixOpen) throw new HttpError(503, 'Remixing is paused for now. Remixes already live keep working.', 'closed');
            const no = remixRefusal(e.agents, parent, w);
            if (no) throw new HttpError(parent ? 409 : 404, no, 'remix_refused');
          } else if (!parent) throw new HttpError(404, 'No such agent.');
        } else if (b.fromAgent) {
          const row = agentSpecOf(String(b.fromAgent), w);
          const prev = row.draft_id ? e.drafts.row(row.draft_id) : null;
          from = { id: row.id, spec: e.agents.spec(row), tests: prev?.tests ? JSON.parse(prev.tests) : [] };
        }
        if (from) sentence = `New version of ${from.spec.name}`;
        else {
          try {
            sentence = checkSentence(b.sentence);
          } catch (err) {
            throw new HttpError(400, (err as SpecError).problems.join('; '));
          }
        }
        if (!header) {
          limit(`build:${w}`, LIMITS.buildPerHour, 3_600_000);
          const fee = Math.max(0, Math.round(e.cfg.buildFeeMicros * (1 - (e.tierFor(w).buildDiscountBps ?? 0) / 10_000)));
          const req402 = await e.payments.makeQuote({
            kind: 'build',
            maker: w,
            meta: { sentence, fromAgent: from?.id ?? null, remixOf: parent?.id ?? null },
            price: { total: fee, maker: 0, royalty: 0, ai: fee, platform: 0 },
            ip,
            resource: `${e.cfg.siteUrl}/api/build`,
            description: parent ? `One build round for a remix of ${e.agents.spec(parent).name}: spec, tests and up to three test runs` : 'One build round: spec, tests and up to three test runs',
          });
          return json(402, { x402Version: 1, error: 'Payment required', accepts: [req402] }), true;
        }
        try {
          const s = await e.payments.settle(header, (q) => {
            const meta = q.meta ? JSON.parse(q.meta) : {};
            if (q.kind !== 'build' || q.maker !== w || meta.sentence !== sentence || (meta.remixOf ?? null) !== (parent?.id ?? null)) throw new PaymentError('mismatch', 'That payment was for a different build.', 409);
          });
          const id = e.drafts.create(w, sentence, s.sig, e.cfg.buildAiBudgetMicros, from, parent ? { id: parent.id, spec: e.agents.spec(parent) } : undefined);
          if (!from) void e.drafts.buildSpec(id);
          return json(201, { draftId: id }), true;
        } catch (err) {
          if (err instanceof PaymentError) throw new HttpError(err.status, err.message, err.code);
          throw err;
        }
      }

      const draftM = p.match(/^\/api\/drafts\/(d_[A-Za-z0-9_-]{8,20})(?:\/(spec|respec|tests|run|publish|topup))?$/);
      if (draftM) {
        const w = maker(req);
        const d = ownDraft(draftM[1], w);
        const action = draftM[2];
        if (!action && m === 'GET') return json(200, viewWithPrice(e, e.drafts.row(d.id)!, w)), true;
        sameOrigin(req);
        limit(`draft:${w}`, LIMITS.draftOpsPerMin, 60_000);
        const b = m === 'GET' ? {} : await readBody(req);
        try {
          if (action === 'spec' && m === 'PUT') return json(200, { spec: e.drafts.saveSpec(d.id, b.spec), draft: viewWithPrice(e, e.drafts.row(d.id)!, w) }), true;
          if (action === 'respec' && m === 'POST') {
            buildRoom();
            void e.drafts.buildSpec(d.id);
            return json(202, { ok: true }), true;
          }
          if (action === 'tests' && m === 'POST') {
            buildRoom();
            void e.drafts.buildTests(d.id);
            return json(202, { ok: true }), true;
          }
          if (action === 'tests' && m === 'PUT') return json(200, { tests: e.drafts.editTests(d.id, b) }), true;
          if (action === 'run' && m === 'POST') {
            buildRoom();
            const pr = e.drafts.runTests(d.id);
            pr.catch(() => {});
            // runTests throws synchronously-ish for refusals; give it a tick to surface them.
            const early = await Promise.race([pr.then(() => null, (x) => x), new Promise((r) => setTimeout(() => r(null), 50))]);
            if (early instanceof Error) throw early;
            return json(202, { ok: true }), true;
          }
          if (action === 'publish' && m === 'POST') return json(201, publish(e, d.id, w)), true;
          if (action === 'topup' && m === 'POST') {
            const header = String(req.headers['x-payment'] ?? '') || undefined;
            if (!header) {
              const fee = Math.max(0, Math.round(e.cfg.buildFeeMicros * (1 - (e.tierFor(w).buildDiscountBps ?? 0) / 10_000)));
              const q = await e.payments.makeQuote({ kind: 'build', maker: w, meta: { topup: d.id }, price: { total: fee, maker: 0, royalty: 0, ai: fee, platform: 0 }, ip, resource: `${e.cfg.siteUrl}/api/drafts/${d.id}/topup`, description: `Another build round: ${MAX_RUNS_PER_FEE} more test runs` });
              return json(402, { x402Version: 1, error: 'Payment required', accepts: [q] }), true;
            }
            const s = await e.payments.settle(header, (q) => {
              const meta = q.meta ? JSON.parse(q.meta) : {};
              if (q.kind !== 'build' || q.maker !== w || meta.topup !== d.id) throw new PaymentError('mismatch', 'That payment was for something else.', 409);
            });
            e.drafts.addBudget(d.id, e.cfg.buildAiBudgetMicros, s.sig);
            return json(200, viewWithPrice(e, e.drafts.row(d.id)!, w)), true;
          }
        } catch (err) {
          if (err instanceof SpecError) throw new HttpError(400, err.problems.join('; '));
          if (err instanceof PaymentError) throw new HttpError(err.status, err.message, err.code);
          throw err;
        }
        throw new HttpError(405, 'Method not allowed.');
      }

      // ---------------------------------------------------------------- agents: reads
      if (p === '/api/agents' && m === 'GET') {
        const list = e.listAgents({ sort: (url.searchParams.get('sort') as SortKey) ?? undefined, q: url.searchParams.get('q') ?? undefined, tool: url.searchParams.get('tool') ?? undefined, category: url.searchParams.get('category') ?? undefined });
        return json(200, { agents: list.map((a) => ({ ...a, endpoint: `${e.cfg.siteUrl}/api/agents/${a.slug}/run` })) }), true;
      }
      if (p === '/api/x402' && m === 'GET') {
        const list = e.listAgents({}).filter((a) => a.status === 'live');
        return json(200, { x402Version: 1, items: list.map((a) => ({ resource: `${e.cfg.siteUrl}/api/agents/${a.slug}/run`, type: 'http', method: 'POST', scheme: 'split', network: e.cfg.network, asset: e.cfg.usdcMint, maxAmountRequired: String(a.price.total), description: a.tagline })) }), true;
      }
      // ---------------------------------------------------------------- versions, the changelog and signed test reports
      const verM = p.match(/^\/api\/agents\/([a-z0-9-]{1,60})\/versions(?:\/(\d{1,4})(\/report)?)?$/);
      if (verM) {
        const row = e.agents.row(verM[1]);
        if (!row || row.status === 'retired') throw new HttpError(404, 'No such agent.');
        e.versions.ensure(row);
        const n = verM[2] ? Number(verM[2]) : null;
        if (m === 'GET' && n === null) {
          return json(200, { slug: row.slug, live: row.version, versions: e.versions.list(row), changelog: e.versions.changelog(row), open: e.cfg.versionsOpen, limits: VERSION_LIMITS }), true;
        }
        if (m === 'GET' && n !== null) {
          const v = e.versions.row(row.id, n);
          if (!v) throw new HttpError(404, `There is no version ${n} of this agent.`);
          const report = e.versions.report(row, n);
          const results = e.versions.results(row, n);
          if (verM[3]) {
            if (!report) throw new HttpError(404, `Version ${n} has no test report.`);
            const { format: _f, signature: _s, ...body } = report;
            return json(200, { report, message: reportMessage(body), format: TEST_REPORT_FORMAT, publicKey: bs58.encode(e.receiptKeys.publicKey), results }), true;
          }
          const spec = JSON.parse(v.spec) as AgentSpec;
          // Only what every buyer could see while it was live: never the instructions.
          const pub = { name: spec.name, tagline: spec.tagline, brief: spec.brief, category: spec.category, model: spec.model, tools: Object.keys(spec.tools), toolConfig: spec.tools, input: spec.input, output: spec.output, examples: spec.examples, limits: spec.limits };
          return json(200, { ...e.versions.publicOf(row, v), agent: pub, report, results }), true;
        }
        if (m === 'POST' && n === null) {
          const w = maker(req);
          sameOrigin(req);
          buildRoom();
          const mine = agentSpecOf(row.slug, w);
          const b = await readBody(req);
          let sentence: string;
          try {
            sentence = checkSentence(b.sentence);
          } catch (err) {
            throw new HttpError(400, (err as SpecError).problems.join('; '));
          }
          const header = String(req.headers['x-payment'] ?? req.headers['payment-signature'] ?? '') || undefined;
          if (!header) {
            // Checked before the quote, so nobody pays for a refusal. A payment already made is honoured even if the
            // switch was turned off since.
            if (!e.cfg.versionsOpen) throw new HttpError(503, 'New versions are paused for now. Live agents keep working.', 'closed');
            const no = versionRefusal(e.versions, (id) => e.drafts.openImprove(id, Date.now(), VERSION_LIMITS.openDraftIdleMs), mine);
            if (no) throw new HttpError(no.status, no.message, 'version_refused', no.draftId ? { draftId: no.draftId } : {});
            limit(`build:${w}`, LIMITS.buildPerHour, 3_600_000);
            const fee = Math.max(0, Math.round(e.cfg.buildFeeMicros * (1 - (e.tierFor(w).buildDiscountBps ?? 0) / 10_000)));
            const spec = e.agents.spec(mine);
            const req402 = await e.payments.makeQuote({
              kind: 'build',
              maker: w,
              meta: { sentence, improve: mine.id, fromVersion: mine.version },
              price: { total: fee, maker: 0, royalty: 0, ai: fee, platform: 0 },
              ip,
              resource: `${e.cfg.siteUrl}/api/agents/${mine.slug}/versions`,
              description: `One build round for a new version of ${spec.name}: the change, tests and up to three test runs`,
            });
            return json(402, { x402Version: 1, error: 'Payment required', accepts: [req402] }), true;
          }
          try {
            const s = await e.payments.settle(header, (q) => {
              const meta = q.meta ? JSON.parse(q.meta) : {};
              if (q.kind !== 'build' || q.maker !== w || meta.improve !== mine.id || meta.sentence !== sentence) throw new PaymentError('mismatch', 'That payment was for something else.', 409);
            });
            const fresh = e.agents.row(mine.id)!;
            const id = e.drafts.create(w, sentence, s.sig, e.cfg.buildAiBudgetMicros, undefined, undefined, { agentId: fresh.id, spec: e.agents.spec(fresh), version: fresh.version });
            void e.drafts.buildSpec(id);
            return json(201, { draftId: id }), true;
          } catch (err) {
            if (err instanceof PaymentError) throw new HttpError(err.status, err.message, err.code);
            throw err;
          }
        }
        throw new HttpError(405, 'Method not allowed.');
      }
      const agentM = p.match(/^\/api\/agents\/([a-z0-9-]{1,60})(?:\/(tests|receipts|earnings|remixes|run|pause|resume|rollback|coin\/prepare|coin\/confirm|buyback|buyback\/tx|buyback\/confirm|burn\/confirm))?$/);
      if (agentM) {
        const slug = agentM[1];
        const action = agentM[2];
        if (!action && m === 'GET') {
          const a = e.agent(slug);
          if (!a) throw new HttpError(404, 'No such agent.');
          return json(200, { ...a, endpoint: `${e.cfg.siteUrl}/api/agents/${a.slug}/run`, mcp: `${e.cfg.siteUrl}/mcp/agents/${a.slug}`, versions: `${e.cfg.siteUrl}/api/agents/${a.slug}/versions` }), true;
        }
        if (action === 'tests' && m === 'GET') return json(200, { results: e.agentTests(slug) }), true;
        if (action === 'receipts' && m === 'GET') return json(200, { receipts: e.receipts(slug, Number(url.searchParams.get('limit') ?? 25), url.searchParams.get('before') ? Number(url.searchParams.get('before')) : undefined) }), true;
        if (action === 'earnings' && m === 'GET') return json(200, { days: e.earningsSeries(slug) }), true;
        if (action === 'remixes' && m === 'GET') {
          const row = e.agents.row(slug);
          if (!row || row.status === 'retired') throw new HttpError(404, 'No such agent.');
          return json(200, { remixes: e.remixesOf(slug).map((a) => ({ ...a, endpoint: `${e.cfg.siteUrl}/api/agents/${a.slug}/run` })), royaltiesMicros: e.agents.royaltiesPaid(row.id) }), true;
        }
        if (action === 'run' && m === 'POST') {
          limit(`run:${ip}`, LIMITS.runPerMin, 60_000);
          const b = await readBody(req);
          const r = await e.calls.handle(slug, b, { payment: String(req.headers['x-payment'] ?? req.headers['payment-signature'] ?? '') || undefined, retry: String(req.headers['x-fabrica-retry'] ?? '') || undefined }, ip);
          return json(r.status, r.body, r.headers ?? {}), true;
        }
        // Maker actions below.
        const w = maker(req);
        sameOrigin(req);
        limit(`maker:${w}`, 60, 60_000);
        const b = await readBody(req);
        try {
          if (!action && m === 'PATCH') return json(200, patchAgent(e, slug, w, b)), true;
          if ((action === 'pause' || action === 'resume') && m === 'POST') {
            const row = agentSpecOf(slug, w);
            if (action === 'resume' && kvGet(e.db, `adminpause:${row.id}`)) throw new HttpError(403, 'Fabrica paused this agent. It cannot be resumed from here.');
            return json(200, e.setAgentPaused(slug, action === 'pause', action === 'pause' ? 'Paused by its maker' : null, w)), true;
          }
          if (action === 'rollback' && m === 'POST') {
            if (!e.cfg.versionsOpen) throw new HttpError(503, 'Rollbacks are paused for now. The live version keeps working.', 'closed');
            const row = agentSpecOf(slug, w);
            if (row.status === 'retired') throw new HttpError(404, 'No such agent of yours.');
            const to = Number(b.version);
            if (!Number.isInteger(to) || to < 1) throw new HttpError(400, 'Name the version to roll back to: {"version": 1}.');
            e.versions.ensure(row);
            e.versions.rollback(row, to, w);
            return json(200, { ...e.agent(slug), changelog: e.versions.changelog(e.agents.row(slug)!) }), true;
          }
          if (action === 'coin/prepare' && m === 'POST') return json(200, e.coins.prepare(slug, w, b)), true;
          if (action === 'coin/confirm' && m === 'POST') return json(200, await e.coins.confirmLaunch(slug, w, String(b.signature ?? ''), String(b.mint ?? ''))), true;
          if (action === 'buyback' && m === 'POST') return json(200, e.coins.setBuyback(slug, w, Number(b.bps))), true;
          if (action === 'buyback/tx' && m === 'POST') return json(200, await e.coins.buybackTransaction(slug, w, Number(b.amountMicros))), true;
          if (action === 'buyback/confirm' && m === 'POST') return json(200, await e.coins.confirmBuy(slug, w, String(b.signature ?? ''))), true;
          if (action === 'burn/confirm' && m === 'POST') return json(200, await e.coins.confirmBurn(slug, w, String(b.signature ?? ''))), true;
        } catch (err) {
          if (err instanceof CoinError) throw new HttpError(err.status, err.message);
          if (err instanceof VersionError) throw new HttpError(err.status, err.message, 'version_refused');
          throw err;
        }
        throw new HttpError(405, 'Method not allowed.');
      }
      const progM = p.match(/^\/api\/runs\/([0-9a-f]{24})$/);
      if (progM && m === 'GET') return json(200, e.calls.progressOf(progM[1]) ?? { stage: 'unknown', events: [] }), true;
      const recM = p.match(/^\/api\/receipts\/(r_[A-Za-z0-9_-]{12})$/);
      if (recM && m === 'GET') {
        const r = e.receipt(recM[1]);
        if (!r) throw new HttpError(404, 'No such receipt.');
        return json(200, { receipt: r, publicKey: bs58.encode(e.receiptKeys.publicKey) }), true;
      }
      if (p === '/api/receipts/key' && m === 'GET') return json(200, { publicKey: bs58.encode(e.receiptKeys.publicKey), message: RECEIPT_FORMATS.v1, messageWithRoyalty: RECEIPT_FORMATS.v2, messageWithVersion: RECEIPT_FORMATS.v3, testReport: TEST_REPORT_FORMAT }), true;
      if (p === '/api/token' && m === 'GET') return json(200, { launched: Boolean(e.cfg.mint), stats: await e.token.stats() }), true;

      // ---------------------------------------------------------------- MCP
      if ((p === '/mcp' || p.startsWith('/mcp/agents/')) && m === 'POST') {
        limit(`mcp:${ip}`, LIMITS.mcpPerMin, 60_000);
        const only = p.startsWith('/mcp/agents/') ? p.slice('/mcp/agents/'.length) : undefined;
        const b = await readBody(req);
        const msgs = Array.isArray(b) ? b : [b];
        const out = (await Promise.all(msgs.slice(0, 20).map((x) => handleMcp(e, x, ip, only)))).filter((x) => x !== null);
        if (!out.length) {
          res.writeHead(202, cors);
          res.end();
          return true;
        }
        return json(200, Array.isArray(b) ? out : out[0], { 'mcp-protocol-version': '2025-06-18' }), true;
      }
      if ((p === '/mcp' || p.startsWith('/mcp/agents/')) && m === 'GET') {
        // A person opening the link in a browser gets the docs on how to connect; an MCP client gets the 405 it expects.
        if (String(req.headers.accept ?? '').includes('text/html')) {
          res.writeHead(302, { location: '/docs#mcp' });
          res.end();
          return true;
        }
        res.writeHead(405, { ...cors, allow: 'POST' });
        res.end();
        return true;
      }

      // ---------------------------------------------------------------- files and coin metadata
      const fileM = p.match(/^\/files\/([0-9a-f]{24})\/[^/]+$/);
      if (fileM && m === 'GET') {
        const f = e.files.get(fileM[1]);
        if (!f) throw new HttpError(404, 'No such file.');
        res.writeHead(200, {
          'content-type': MIME[f.format],
          'content-disposition': `attachment; filename="${f.name.replace(/"/g, '')}"`,
          'content-security-policy': "sandbox; default-src 'none'",
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, max-age=3600',
        });
        res.end(f.body);
        return true;
      }
      const metaM = p.match(/^\/coin-meta\/([a-z0-9-]{1,60})\.json$/);
      if (metaM && m === 'GET') {
        const row = e.agents.row(metaM[1]);
        const meta = row ? e.coins.meta(row) : null;
        if (!meta) throw new HttpError(404, 'No coin for this agent.');
        return json(200, { name: meta.name, symbol: meta.symbol, description: meta.description, image: meta.image, showName: true, createdOn: e.cfg.siteUrl, website: meta.website }, { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' }), true;
      }

      // ---------------------------------------------------------------- admin
      if (p.startsWith('/api/admin/')) {
        if (!adminOk(req.headers.authorization, e.cfg.adminToken)) throw new HttpError(401, 'Not allowed.');
        const b = m === 'POST' ? await readBody(req) : {};
        if (p === '/api/admin/state' && m === 'GET') {
          return json(200, { health: e.health(), totals: e.totals(), agents: e.listAgents({}).map((a) => ({ slug: a.slug, status: a.status, maker: a.maker, calls: a.stats.paidCalls, aiToday: e.ledger.spent(a.id) })), audit: e.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 50').all() }), true;
        }
        const am = p.match(/^\/api\/admin\/agents\/([a-z0-9-]{1,60})\/(pause|resume)$/);
        if (am && m === 'POST') {
          const row = e.agents.row(am[1]);
          if (!row) throw new HttpError(404, 'No such agent.');
          if (am[2] === 'pause') kvSet(e.db, `adminpause:${row.id}`, '1');
          else e.db.prepare('DELETE FROM kv WHERE k = ?').run(`adminpause:${row.id}`);
          return json(200, e.setAgentPaused(am[1], am[2] === 'pause', am[2] === 'pause' ? String(b.reason ?? 'Paused by Fabrica for review') : null, 'admin')), true;
        }
        if (p === '/api/admin/switch' && m === 'POST') {
          for (const k of ['calls', 'builds'] as const) if (typeof b[k] === 'boolean') setSwitch(e.db, k, b[k]);
          audit(e.db, 'admin', 'switch', b);
          return json(200, e.health().switches), true;
        }
        if (p === '/api/admin/backups' && m === 'GET') return json(200, { backups: e.backups.list(), health: e.backups.health() }), true;
        if (p === '/api/admin/backups' && m === 'POST') {
          audit(e.db, 'admin', 'backup', {});
          return json(201, e.backups.run()), true;
        }
        const bm = p.match(/^\/api\/admin\/backups\/(latest|fabrica-\d{8}-\d{6}\.db)$/);
        if (bm && m === 'GET') {
          const info = bm[1] === 'latest' ? e.backups.list()[0] : e.backups.list().find((x) => x.file === bm[1]);
          const file = info ? e.backups.path(info.file) : null;
          if (!info || !file) throw new HttpError(404, 'No backup yet.');
          res.writeHead(200, {
            'content-type': 'application/vnd.sqlite3',
            'content-length': String(fs.statSync(file).size),
            'content-disposition': `attachment; filename="${info.file}"`,
            'x-backup-file': info.file,
            'x-backup-sha256': info.sha256,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
          await new Promise<void>((resolve, reject) => fs.createReadStream(file).on('error', reject).on('end', resolve).pipe(res));
          return true;
        }
        if (p === '/api/admin/burn' && m === 'POST') return json(200, { result: await e.token.burnTick() }), true;
        if (p === '/api/admin/record-burn' && m === 'POST') {
          try {
            return json(200, await e.token.recordManualBurn(String(b.signature ?? ''))), true;
          } catch (err) {
            throw new HttpError(400, (err as Error).message);
          }
        }
        throw new HttpError(404, 'No such admin action.');
      }

      // ---------------------------------------------------------------- the pretend chain, only in test mode
      if (p.startsWith('/api/__test/')) {
        if (!e.cfg.testMode || !(e.rpc instanceof FakeChain)) throw new HttpError(404, 'Not found.');
        const chain = e.rpc;
        const b = m === 'POST' ? await readBody(req) : {};
        if (p === '/api/__test/fund' && m === 'POST') {
          chain.fundUsdc(String(b.wallet), Number(b.micros));
          return json(200, { balance: String(chain.usdcBalance(String(b.wallet))) }), true;
        }
        if (p === '/api/__test/send' && m === 'POST') {
          const sig = await chain.call('sendTransaction', [String(b.transaction)]);
          return json(200, { signature: sig }), true;
        }
        if (p === '/api/__test/balance' && m === 'GET') return json(200, { balance: String(chain.usdcBalance(String(url.searchParams.get('wallet')))) }), true;
        throw new HttpError(404, 'Not found.');
      }

      throw new HttpError(404, 'Not found.');
    } catch (err) {
      if (err instanceof HttpError) {
        json(err.status, { error: err.code, message: err.message, ...err.extra }, err.status === 429 ? { 'retry-after': '60' } : {});
        return true;
      }
      e.log(`api ${m} ${p} failed: ${(err as Error).stack ?? err}`);
      json(500, { error: 'internal', message: 'Something went wrong on our side. Nothing was charged for this request.' });
      return true;
    }
  };
}

function viewWithPrice(e: Engine, row: NonNullable<ReturnType<Engine['drafts']['row']>>, wallet: string) {
  const v = e.drafts.view(row);
  // A remix shows the royalty it will pay; a new version of a remix keeps paying its own.
  const live = row.agent_id ? e.agents.row(row.agent_id) : null;
  const royaltyBps = v.remix?.royaltyBps ?? (live ? e.agents.royalty(live).bps : 0);
  return { ...v, price: v.spec ? priceFor(v.spec, e.cfg, e.tierFor(wallet), royaltyBps) : null, buildFee: e.cfg.buildFeeMicros };
}

function patchAgent(e: Engine, slug: string, wallet: string, b: any) {
  const row = e.agents.row(slug);
  if (!row || row.example || row.maker !== wallet) throw new HttpError(404, 'No such agent of yours.');
  const spec = e.agents.spec(row);
  // Only what does not change behaviour can change without a new test run.
  if (b.makerFee !== undefined) {
    const v = Math.round(Number(b.makerFee));
    if (!(v >= 1000 && v <= 5_000_000)) throw new HttpError(400, 'Earnings per call must be between 0.001 and 5 USDC.');
    if (v < row.fee_floor) throw new HttpError(400, `A remix earns at least what the original earned per call when it went live (${row.fee_floor / 1e6} USDC).`);
    spec.makerFee = v;
  }
  if (typeof b.tagline === 'string') spec.tagline = b.tagline.trim().slice(0, 90) || spec.tagline;
  if (typeof b.brief === 'string' && b.brief.trim().length >= 20) spec.brief = b.brief.trim().slice(0, 600);
  e.db.prepare('UPDATE agents SET spec = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(spec), Date.now(), row.id);
  audit(e.db, wallet, 'agent_edit', { agent: slug, fields: Object.keys(b) });
  return e.agent(slug);
}

function publish(e: Engine, draftId: string, wallet: string) {
  const v = e.drafts.view(e.drafts.row(draftId)!);
  if (!v.spec || !v.run) throw new HttpError(409, 'Run the tests first.');
  if (!v.specHashTested) throw new HttpError(409, 'The spec or tests changed after the last run. Run the tests again.');
  if (!v.run.publishable) throw new HttpError(409, 'Only agents that pass every safety test and at least 80 percent of their task tests go live.');
  const d = e.drafts.row(draftId)!;
  const now = Date.now();
  const others = e.db.prepare("SELECT * FROM agents WHERE example = 0 AND status IN ('live','paused')").all() as unknown as AgentRow[];
  const copyRefusal = (copy: AgentRow | null) => {
    if (copy) throw new HttpError(409, `These instructions repeat ${e.agents.spec(copy).name} nearly word for word. Remix ${e.agents.spec(copy).name} instead, so its maker earns a royalty.`, 'copy');
  };
  if (d.agent_id) {
    const row = e.agents.row(d.agent_id);
    if (!row || row.maker !== wallet || row.status === 'retired') throw new HttpError(404, 'No such agent of yours.');
    e.versions.ensure(row);
    // A new version keeps its lineage, its royalty and its price floor.
    if (v.spec.makerFee < row.fee_floor) throw new HttpError(409, `A remix earns at least what the original earned per call when it went live (${row.fee_floor / 1e6} USDC). Raise the earnings in the spec.`);
    if (v.improve) {
      const problems = versionProblems(v.improve.before, v.spec, row.fee_floor);
      if (problems.length) throw new HttpError(409, `${problems.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()));
    }
    if (e.versions.count(row.id) >= VERSION_LIMITS.maxVersions) throw new HttpError(409, `An agent can have ${VERSION_LIMITS.maxVersions} versions.`, 'version_refused');
    if (e.versions.publishedToday(row.id) >= VERSION_LIMITS.perDay) throw new HttpError(429, `An agent can get ${VERSION_LIMITS.perDay} new versions in 24 hours. This draft stays ready; publish it later.`, 'version_refused');
    copyRefusal(copiedFrom(e.agents, others, v.spec, wallet, row, e.agents.lineage(row)));
    const live = e.agents.spec(row);
    const spec = { ...v.spec, slug: row.slug };
    tx(e.db, () => {
      // The number is read inside the transaction, so two publishes can never take the same one.
      const next = e.versions.nextNumber(row.id, row.version);
      e.db.prepare('UPDATE agents SET spec = ?, version = ?, test_run_id = ?, draft_id = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(spec), next, v.run!.id, d.id, now, row.id);
      e.db.prepare('UPDATE test_runs SET agent_id = ? WHERE id = ?').run(row.id, v.run!.id);
      e.versions.record(row, { version: next, spec, testRunId: v.run!.id, draftId: d.id, kind: v.improve ? 'improve' : 'edit', sentence: v.improve ? d.sentence : null, summary: v.improve?.summary ?? null, baseVersion: v.improve?.fromVersion ?? row.version, before: v.improve?.before ?? live, maker: wallet, at: now, fromVersion: row.version });
    });
    e.drafts.markPublished(d.id, row.id);
    return e.agent(row.slug);
  }
  const tier = e.tierFor(wallet);
  if (e.agents.liveCountFor(wallet) >= tier.liveAgents) throw new HttpError(409, `Your plan holds ${tier.liveAgents} live agents. Retire or pause one first.`);
  // A remix: the parent, the royalty and the floor come from the draft the maker paid for, never from the request.
  const parent = d.parent_id ? e.agents.row(d.parent_id) : null;
  if (v.remix) {
    const problems = remixProblems(v.remix.before, v.spec, v.remix.feeFloor);
    if (problems.length) throw new HttpError(409, `${problems.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()));
    if (parent && e.agents.remixCountBy(parent.id, wallet) > 0) throw new HttpError(409, 'You already have a live remix of this agent. Improve it with a new version instead.');
  }
  copyRefusal(copiedFrom(e.agents, others, v.spec, wallet, null, parent ? [parent, ...e.agents.lineage(parent)] : []));
  let slug = v.spec.slug;
  for (let i = 2; e.agents.row(slug); i++) slug = `${v.spec.slug}-${i}`.slice(0, 60);
  const id = e.newId('a');
  const spec = { ...v.spec, slug };
  tx(e.db, () => {
    e.db
      .prepare('INSERT INTO agents (id, slug, maker, status, example, spec, version, test_run_id, draft_id, published_at, updated_at, sentence, parent_id, royalty_bps, fee_floor) VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, slug, wallet, 'live', JSON.stringify(spec), v.run!.id, d.id, now, now, d.sentence, parent?.id ?? null, v.remix?.royaltyBps ?? 0, v.remix?.feeFloor ?? 0);
    e.db.prepare('UPDATE test_runs SET agent_id = ? WHERE id = ?').run(id, v.run!.id);
    e.versions.record({ id, slug }, { version: 1, spec, testRunId: v.run!.id, draftId: d.id, kind: parent ? 'remix' : 'build', sentence: d.sentence, summary: v.remix?.summary ?? null, baseVersion: null, before: null, maker: wallet, at: now });
  });
  if (parent) audit(e.db, wallet, 'remix', { agent: slug, parent: parent.slug, royaltyBps: v.remix?.royaltyBps ?? 0 });
  e.drafts.markPublished(d.id, id);
  return e.agent(slug);
}

