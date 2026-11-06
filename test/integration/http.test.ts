// The whole product over real HTTP: sign in, pay a build round, build, test, publish, sell, MCP, admin, coins.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { addLiveAgent, BURN, makeEngine, OPS, payHeader, serveApi, signInHttp, wallet } from '../helpers';
import { createV2Instruction, burnCheckedInstruction } from '../../shared/pump/instructions';
import { ataAddress } from '../../shared/pump/pda';
import { TOKEN_2022_PROGRAM } from '../../shared/pump/constants';
import type { Brain } from '../../server/ai/fake';

let failNext = 0;
const flaky: Brain = (v) => (v.req.purpose === 'agent' && v.req.ref?.startsWith('flaky') && failNext-- > 0 ? { text: 'no json here' } : null);
const rig = makeEngine({ brains: [flaky] });
const { e, chain } = rig;
let api: Awaited<ReturnType<typeof serveApi>>;
const maker = wallet();
const buyer = wallet();
let cookie = '';
let slug = '';

before(async () => {
  await e.seed();
  api = await serveApi(e);
  chain.fundUsdc(maker.address, 20_000_000);
  chain.fundUsdc(buyer.address, 20_000_000);
  chain.openUsdc(maker.address);
});
after(async () => {
  await api.close();
});

const poll = async (id: string, until: (d: any) => boolean) => {
  for (let i = 0; i < 200; i++) {
    const d = (await api.req(`/api/drafts/${id}`, { cookie })).body;
    if (until(d)) return d;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('draft never got there');
};

test('sign in, pay one build round, build, test and publish', async () => {
  cookie = await signInHttp(api, maker.kp);
  const sentence = 'Summarise any pasted text into three plain bullet points for busy readers';
  const q = await api.req('/api/build', { body: { sentence }, cookie });
  assert.equal(q.status, 402);
  const req = q.body.accepts[0];
  assert.equal(req.extra.recipients.length, 1);
  assert.equal(req.extra.recipients[0].address, OPS);
  const opsBefore = chain.usdcBalance(OPS);
  const paid = await api.req('/api/build', { body: { sentence }, cookie, headers: { 'x-payment': await payHeader(e, req, maker.kp) } });
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  assert.equal(chain.usdcBalance(OPS) - opsBefore, BigInt(req.maxAmountRequired));
  const id = paid.body.draftId;
  let d = await poll(id, (x) => x.status === 'spec');
  assert.ok(d.spec.name);
  assert.ok(d.price.total > d.price.maker);
  const edited = await api.req(`/api/drafts/${id}/spec`, { method: 'PUT', body: { spec: { ...d.spec, tagline: 'Three bullets, no fluff' } }, cookie });
  assert.equal(edited.status, 200);
  await api.req(`/api/drafts/${id}/tests`, { body: {}, cookie });
  d = await poll(id, (x) => x.status === 'tests');
  assert.ok(d.tests.some((t: any) => t.kind === 'injection' && t.required));
  const early = await api.req(`/api/drafts/${id}/publish`, { body: {}, cookie });
  assert.equal(early.status, 409, 'cannot publish untested');
  await api.req(`/api/drafts/${id}/run`, { body: {}, cookie });
  d = await poll(id, (x) => x.status === 'tested');
  assert.equal(d.run.publishable, true, JSON.stringify(d.run.results.filter((r: any) => !r.pass)));
  const pub = await api.req(`/api/drafts/${id}/publish`, { body: {}, cookie });
  assert.equal(pub.status, 201, JSON.stringify(pub.body));
  slug = pub.body.slug;
  assert.equal(pub.body.status, 'live');
  assert.equal(pub.body.maker, maker.address);
});

test('someone else cannot touch the draft or agent', async () => {
  const other = wallet();
  const c = await signInHttp(api, other.kp);
  const me = await api.req('/api/me', { cookie: c });
  assert.equal(me.body.drafts.length, 0);
  const r = await api.req(`/api/agents/${slug}`, { method: 'PATCH', body: { makerFee: 9 }, cookie: c });
  assert.equal(r.status, 404);
  const x = await api.req(`/api/agents/${slug}/pause`, { body: {}, cookie, headers: { origin: 'https://evil.test' } });
  assert.equal(x.status, 403, 'cross-site writes are refused');
});

test('a paid call: quote, one transaction, answer, receipt, money where it belongs', async () => {
  const input = { request: 'Fabrica builds agents from one sentence and tests them in public.' };
  const q = await api.req(`/api/agents/${slug}/run`, { body: { input } });
  assert.equal(q.status, 402);
  const req = q.body.accepts[0];
  const roles = Object.fromEntries(req.extra.recipients.map((r: any) => [r.role, r]));
  assert.equal(roles.maker.address, maker.address);
  assert.equal(roles.ai.address, OPS);
  assert.equal(roles.platform.address, BURN);
  const before = { maker: chain.usdcBalance(maker.address), ops: chain.usdcBalance(OPS), burn: chain.usdcBalance(BURN) };
  const header = await payHeader(e, req, buyer.kp);
  const r = await api.req(`/api/agents/${slug}/run`, { body: { input }, headers: { 'x-payment': header } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.output.answer);
  assert.equal(r.body.receipt.payer, buyer.address);
  assert.ok(r.headers.get('x-payment-response'));
  assert.equal(chain.usdcBalance(maker.address) - before.maker, BigInt(roles.maker.amount));
  assert.equal(chain.usdcBalance(OPS) - before.ops, BigInt(roles.ai.amount));
  assert.equal(chain.usdcBalance(BURN) - before.burn, BigInt(roles.platform.amount));
  const again = await api.req(`/api/agents/${slug}/run`, { body: { input }, headers: { 'x-payment': header } });
  assert.equal(again.status, 409, 'a payment works once');
  const rec = await api.req(`/api/receipts/${r.body.receipt.id}`);
  assert.equal(rec.body.receipt.txSig, r.body.receipt.txSig);
  const stats = await api.req(`/api/agents/${slug}`);
  assert.equal(stats.body.stats.paidCalls, 1);
});

test('signature mode, and a payment cannot be moved to another input', async () => {
  const input = { request: 'First input' };
  const q = await api.req(`/api/agents/${slug}/run`, { body: { input } });
  const header = await payHeader(e, q.body.accepts[0], buyer.kp, 'signature');
  const moved = await api.req(`/api/agents/${slug}/run`, { body: { input: { request: 'Another input' } }, headers: { 'x-payment': header } });
  assert.equal(moved.status, 409);
  const ok = await api.req(`/api/agents/${slug}/run`, { body: { input }, headers: { 'x-payment': header } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const sim = await api.req(`/api/agents/${slug}/run`, { body: { input }, headers: { 'x-payment': Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'split', network: 'solana-localnet', payload: { signature: '1'.repeat(88) } })).toString('base64') } });
  assert.equal(sim.status, 400, 'simulated signatures are not payments');
});

test('a failed paid run gives one free retry', async () => {
  const row = addLiveAgent(e, maker.address, { name: 'Flaky Digest', slug: 'flaky-digest' });
  failNext = 1;
  const input = { request: 'hello' };
  const q = await api.req(`/api/agents/${row.slug}/run`, { body: { input } });
  // The spec allows one step without tools, so a reply outside the contract fails the run.
  const r = await api.req(`/api/agents/${row.slug}/run`, { body: { input }, headers: { 'x-payment': await payHeader(e, q.body.accepts[0], buyer.kp) } });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.ok(r.body.retryToken);
  const retry = await api.req(`/api/agents/${row.slug}/run`, { body: { input }, headers: { 'x-fabrica-retry': r.body.retryToken } });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.receipt.status, 'retried');
  const twice = await api.req(`/api/agents/${row.slug}/run`, { body: { input }, headers: { 'x-fabrica-retry': r.body.retryToken } });
  assert.equal(twice.status, 404);
});

test('MCP lists live agents and sells through the same path', async () => {
  const init = await api.req('/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
  assert.equal(init.body.result.serverInfo.name, 'fabrica');
  const list = await api.req('/mcp', { body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  const tool = list.body.result.tools.find((t: any) => t.name === `run_${slug.replace(/-/g, '_')}`);
  assert.ok(tool, 'live agent is a tool');
  assert.ok(!list.body.result.tools.some((t: any) => t.name === 'run_mint_inspector'), 'examples are not tools');
  const ask = await api.req('/mcp', { body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool.name, arguments: { request: 'MCP input' } } } });
  assert.equal(ask.body.result.isError, true);
  const req = ask.body.result.structuredContent.accepts[0];
  const paid = await api.req('/mcp', { body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: tool.name, arguments: { request: 'MCP input', payment: await payHeader(e, req, buyer.kp) } } } });
  assert.equal(paid.body.result.isError, undefined, JSON.stringify(paid.body));
  assert.ok(paid.body.result._meta.receipt.id);
});

test('examples take no paid calls', async () => {
  const r = await api.req('/api/agents/mint-inspector/run', { body: { input: { mint: 'So11111111111111111111111111111111111111112' } } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'examples_not_for_sale');
});

test('admin pause, switches and the maker cannot undo an admin pause', async () => {
  const auth = { authorization: 'Bearer test-admin-token-0123456789abcdef' };
  assert.equal((await api.req('/api/admin/state')).status, 401);
  const p = await api.req(`/api/admin/agents/${slug}/pause`, { body: { reason: 'review' }, headers: auth });
  assert.equal(p.body.status, 'paused');
  assert.equal((await api.req(`/api/agents/${slug}/run`, { body: { input: { request: 'x' } } })).status, 409);
  assert.equal((await api.req(`/api/agents/${slug}/resume`, { body: {}, cookie })).status, 403);
  await api.req(`/api/admin/agents/${slug}/resume`, { body: {}, headers: auth });
  await api.req('/api/admin/switch', { body: { calls: false }, headers: auth });
  assert.equal((await api.req(`/api/agents/${slug}/run`, { body: { input: { request: 'x' } } })).status, 503);
  await api.req('/api/admin/switch', { body: { calls: true }, headers: auth });
  assert.equal((await api.req(`/api/agents/${slug}/run`, { body: { input: { request: 'x' } } })).status, 402);
});

test('the daily AI cap stops quotes before anyone pays', async () => {
  const row = e.agents.row(slug)!;
  e.ledger.add(row.id, e.cfg.agentDailyAiCapMicros);
  const r = await api.req(`/api/agents/${slug}/run`, { body: { input: { request: 'x' } } });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'spend_cap');
  e.db.prepare('DELETE FROM ai_spend').run();
});

test('abuse: bad input, oversized bodies, too many quotes', async () => {
  assert.equal((await api.req(`/api/agents/${slug}/run`, { body: { input: { nope: 1 } } })).status, 400);
  assert.equal((await api.req(`/api/agents/${slug}/run`, { body: { input: { request: 'x'.repeat(70_000) } } })).status, 413);
  let limited = false;
  for (let i = 0; i < 70 && !limited; i++) limited = (await api.req(`/api/agents/${slug}/run`, { body: { input: { request: `q${i}` } } })).status === 429;
  assert.ok(limited, 'quotes are rate limited');
});

test('the maker launches a coin from their own wallet, then burns', async () => {
  const prep = await api.req(`/api/agents/${slug}/coin/prepare`, { body: { name: 'Digest Coin', symbol: 'DGST', description: 'x' }, cookie });
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  const meta = await api.req(`/coin-meta/${slug}.json`);
  assert.equal(meta.body.symbol, 'DGST');
  const mint = Keypair.generate();
  const bh = (await e.rpc.call('getLatestBlockhash', [])).value.blockhash;
  const tx = new Transaction({ feePayer: maker.kp.publicKey, recentBlockhash: bh }).add(createV2Instruction({ mint: mint.publicKey, user: maker.kp.publicKey, name: 'Digest Coin', symbol: 'DGST', uri: prep.body.uri }));
  tx.sign(maker.kp, mint);
  const sig = await e.rpc.call('sendTransaction', [tx.serialize().toString('base64')]);
  const stranger = await api.req(`/api/agents/${slug}/coin/confirm`, { body: { signature: sig, mint: Keypair.generate().publicKey.toBase58() }, cookie });
  assert.equal(stranger.status, 400, 'a transaction that did not create that mint is refused');
  const ok = await api.req(`/api/agents/${slug}/coin/confirm`, { body: { signature: sig, mint: mint.publicKey.toBase58() }, cookie });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.coin.symbol, 'DGST');
  assert.equal((await api.req(`/api/agents/${slug}/buyback`, { body: { bps: 2500 }, cookie })).body.coin.buybackBps, 2500);
  assert.equal((await api.req(`/api/agents/${slug}/buyback`, { body: { bps: 9000 }, cookie })).status, 400);
  // The maker holds some of the coin and burns it.
  const ata = ataAddress(maker.kp.publicKey, mint.publicKey).toBase58();
  chain.accounts.set(ata, { owner: maker.address, mint: mint.publicKey.toBase58(), amount: 5_000_000n });
  const burn = new Transaction({ feePayer: maker.kp.publicKey, recentBlockhash: bh }).add(burnCheckedInstruction(maker.kp.publicKey, mint.publicKey, 2_000_000n, 6, TOKEN_2022_PROGRAM));
  burn.sign(maker.kp);
  const bsig = await e.rpc.call('sendTransaction', [burn.serialize().toString('base64')]);
  const b = await api.req(`/api/agents/${slug}/burn/confirm`, { body: { signature: bsig }, cookie });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal((await api.req(`/api/agents/${slug}`)).body.coin.burnedRaw, '2000000');
  assert.equal((await api.req(`/api/agents/${slug}/burn/confirm`, { body: { signature: bsig }, cookie })).status, 409);
  assert.ok(new PublicKey(mint.publicKey));
});
