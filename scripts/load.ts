// Load test of the paid-call path: many buyers, several agents, real signed transactions on the pretend chain,
// real verification, recorded model replies with a delay standing in for model latency. Nothing costs money.
// Usage: npm run load [-- calls concurrency]
import { addLiveAgent, BURN, makeEngine, OPS, payHeader, serveApi, wallet } from '../test/helpers';

const CALLS = Number(process.argv[2] ?? 600);
const CONC = Number(process.argv[3] ?? 40);
const { e, chain } = makeEngine({ fake: { delayMs: 40 }, env: { FABRICA_TRUST_PROXY_HOPS: '1', FABRICA_DAILY_AI_CAP_USD: '100000', FABRICA_AGENT_DAILY_AI_CAP_USD: '100000' } });
const api = await serveApi(e);
const makers = Array.from({ length: 5 }, () => wallet());
const agents = makers.map((m, i) => addLiveAgent(e, m.address, { name: `Load Agent ${i + 1}`, slug: `load-agent-${i + 1}` }));
const buyers = Array.from({ length: 200 }, (_, i) => ({ ...wallet(), ip: `10.9.${i >> 8}.${i & 255}` }));
for (const b of buyers) chain.fundUsdc(b.address, 50_000_000);

const lat: number[] = [];
let ok = 0;
let fail = 0;
const errors = new Map<string, number>();
let next = 0;
const started = Date.now();
async function worker() {
  for (;;) {
    const i = next++;
    if (i >= CALLS) return;
    const b = buyers[i % buyers.length];
    const a = agents[i % agents.length];
    const input = { request: `load call ${i}` };
    const t = Date.now();
    try {
      const headers = { 'x-forwarded-for': b.ip };
      const q = await api.req(`/api/agents/${a.slug}/run`, { body: { input }, headers });
      if (q.status !== 402) throw new Error(`quote ${q.status}`);
      const pay = await payHeader(e, q.body.accepts[0], b.kp, i % 2 ? 'transaction' : 'signature');
      const r = await api.req(`/api/agents/${a.slug}/run`, { body: { input }, headers: { ...headers, 'x-payment': pay } });
      if (r.status !== 200) throw new Error(`run ${r.status} ${r.body?.error}`);
      ok++;
      lat.push(Date.now() - t);
    } catch (err) {
      fail++;
      const k = String((err as Error).message).slice(0, 60);
      errors.set(k, (errors.get(k) ?? 0) + 1);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
const secs = (Date.now() - started) / 1000;
lat.sort((x, y) => x - y);
const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? 0;

// Replay storm: one payment header, many parallel tries. Exactly one may run.
const storm = buyers[0];
const sq = await api.req(`/api/agents/${agents[0].slug}/run`, { body: { input: { request: 'storm' } }, headers: { 'x-forwarded-for': '10.99.0.1' } });
const header = await payHeader(e, sq.body.accepts[0], storm.kp);
const tries = await Promise.all(Array.from({ length: 25 }, (_, k) => api.req(`/api/agents/${agents[0].slug}/run`, { body: { input: { request: 'storm' } }, headers: { 'x-payment': header, 'x-forwarded-for': `10.98.0.${k}` } })));
const stormOk = tries.filter((t) => t.status === 200).length;

// The books must balance to the micro-USDC.
const sums = e.db.prepare('SELECT COUNT(*) AS n, SUM(maker_amt) AS m, SUM(ai_amt) AS a, SUM(platform_amt) AS p FROM receipts').get() as { n: number; m: number; a: number; p: number };
const makerTotal = makers.reduce((n, m) => n + chain.usdcBalance(m.address), 0n);
const booksOk = BigInt(sums.m) === makerTotal && BigInt(sums.a) === chain.usdcBalance(OPS) && BigInt(sums.p) === chain.usdcBalance(BURN);
const doubleUse = (e.db.prepare('SELECT COUNT(*) AS n FROM (SELECT tx_sig FROM receipts GROUP BY tx_sig HAVING COUNT(*) > 1)').get() as { n: number }).n;

console.log(JSON.stringify({ calls: CALLS, concurrency: CONC, ok, fail, errors: Object.fromEntries(errors), seconds: secs.toFixed(1), callsPerSecond: (ok / secs).toFixed(1), p50ms: q(0.5), p95ms: q(0.95), p99ms: q(0.99), maxMs: lat[lat.length - 1], receipts: sums.n, stormTries: 25, stormSucceeded: stormOk, booksBalance: booksOk, doubleUsedTransactions: doubleUse }, null, 2));
await api.close();
const pass = fail === 0 && stormOk === 1 && booksOk && doubleUse === 0 && sums.n === ok + 1;
process.exit(pass ? 0 : 1);
