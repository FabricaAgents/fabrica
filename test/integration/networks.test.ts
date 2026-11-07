// Agent networks over real HTTP on the pretend chain: one quote with every hired maker in it, one payment, hired calls
// on the paid plan only, signed receipt trees, refusals before payment, the hire list in the build flow and the
// NETWORKS switch.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { addLiveAgent, BURN, makeEngine, OPS, payHeader, serveApi, signInHttp, wallet } from '../helpers';
import { verifyReceipt } from '../../server/pay/receipts';
import type { Brain } from '../../server/ai/fake';
import type { AgentSpec, PaymentRequirements } from '../../shared/types';

let flakyAnswers = 0;
// A top agent that hires once and then fails its own answer until it is retried.
const flaky: Brain = (v) => {
  if (v.req.ref !== 'flaky-top' || v.req.purpose !== 'agent') return null;
  if (!v.tools().length) return { toolCalls: [{ name: 'hire_agent', args: { agent: 'reader-agent', input: { request: 'Read this short note.' } } }] };
  return flakyAnswers++ < 3 ? { text: 'not json' } : { text: JSON.stringify({ answer: 'Done after a retry.', confidence: 'high' }) };
};

const { e, chain } = makeEngine({ brains: [flaky] });
let api: Awaited<ReturnType<typeof serveApi>>;
const [orig, readerMaker, midMaker, deepMaker, topMaker, buyer, builder] = [wallet(), wallet(), wallet(), wallet(), wallet(), wallet(), wallet()];
const tools = (agents: { slug: string; calls: number }[], budget = 300_000) => ({ hire_agent: { agents, budget } });
const limits = { maxSteps: 4, maxOutputTokens: 700, maxInputChars: 6000 };

before(async () => {
  await e.seed();
  api = await serveApi(e);
  for (const w of [buyer, builder]) chain.fundUsdc(w.address, 50_000_000);
  const parent = addLiveAgent(e, orig.address, { name: 'Note Reader', slug: 'note-reader', makerFee: 6_000 });
  const reader = addLiveAgent(e, readerMaker.address, { name: 'Reader Agent', slug: 'reader-agent', makerFee: 6_000 });
  // The reader is a remix: a hired call to it still pays its original maker a royalty.
  e.db.prepare('UPDATE agents SET parent_id = ?, royalty_bps = 2000 WHERE id = ?').run(parent.id, reader.id);
  addLiveAgent(e, deepMaker.address, { name: 'Deep Helper', slug: 'deep-helper', makerFee: 4_000 });
  addLiveAgent(e, midMaker.address, { name: 'Mid Agent', slug: 'mid-agent', makerFee: 5_000, tools: tools([{ slug: 'deep-helper', calls: 1 }]), limits });
  addLiveAgent(e, topMaker.address, { name: 'Top Agent', slug: 'top-agent', makerFee: 9_000, tools: tools([{ slug: 'reader-agent', calls: 1 }, { slug: 'mid-agent', calls: 1 }]), limits });
  addLiveAgent(e, topMaker.address, { name: 'Flaky Top', slug: 'flaky-top', makerFee: 9_000, tools: tools([{ slug: 'reader-agent', calls: 1 }]), limits });
  addLiveAgent(e, topMaker.address, { name: 'Plain Agent', slug: 'plain-agent', makerFee: 9_000 });
});
after(async () => {
  await api.close();
});

const input = { request: 'Check these notes: ship on Friday, Sam writes the docs.' };
const bal = (w: { address: string }) => chain.usdcBalance(w.address);
const quote = async (slug: string, body = input) => api.req(`/api/agents/${slug}/run`, { body: { input: body } });
const pay = async (slug: string, req: PaymentRequirements, kp = buyer.kp, body = input) => api.req(`/api/agents/${slug}/run`, { body: { input: body }, headers: { 'x-payment': await payHeader(e, req, kp) } });
const setSpec = (slug: string, patch: Partial<AgentSpec>) => {
  const row = e.agents.row(slug)!;
  e.db.prepare('UPDATE agents SET spec = ? WHERE id = ?').run(JSON.stringify({ ...e.agents.spec(row), ...patch }), row.id);
};

test('the price before you run: one quote lists every hired maker, the royalty of a hired remix, and the cap', async () => {
  const a = (await api.req('/api/agents/top-agent')).body;
  assert.ok(a.network && a.network.slots === 3, JSON.stringify(a.network));
  assert.equal(a.network.problem, null);
  assert.equal(a.price.total, a.price.maker + a.price.royalty + a.price.ai + a.price.platform + a.price.hires);
  const q = await quote('top-agent');
  assert.equal(q.status, 402, JSON.stringify(q.body));
  const req = q.body.accepts[0] as PaymentRequirements;
  assert.equal(Number(req.maxAmountRequired), a.price.total, 'the page shows what the quote asks');
  assert.deepEqual(q.body.network.slots.map((s: any) => [s.slot, s.parent, s.depth, s.agent]), [
    [1, 0, 2, 'reader-agent'],
    [2, 0, 2, 'mid-agent'],
    [3, 2, 3, 'deep-helper'],
  ]);
  assert.equal(q.body.network.budget, 300_000);
  const by = new Map(req.extra.recipients.map((r) => [r.address, r]));
  const slots = q.body.network.slots;
  assert.equal(Number(by.get(readerMaker.address)!.amount), slots[0].maker);
  assert.equal(by.get(readerMaker.address)!.role, 'hire');
  assert.equal(Number(by.get(orig.address)!.amount), slots[0].royalty, 'the hired remix pays its original maker');
  assert.ok(slots[0].royalty > 0);
  assert.equal(Number(by.get(midMaker.address)!.amount), slots[1].maker);
  assert.equal(Number(by.get(deepMaker.address)!.amount), slots[2].maker, 'a level-three hire is paid in the same transaction');
  assert.equal(Number(by.get(OPS)!.amount), a.price.ai + slots.reduce((n: number, s: any) => n + s.ai, 0));
  assert.equal(Number(by.get(BURN)!.amount), a.price.platform + slots.reduce((n: number, s: any) => n + s.platform, 0));
  assert.equal(req.extra.recipients.reduce((n, r) => n + Number(r.amount), 0), Number(req.maxAmountRequired));
  assert.match(req.description, /up to 3 hired calls/);
});

test('one payment, hires mid-run, each hired maker paid, and a signed receipt tree', async () => {
  const q = await quote('top-agent');
  const req = q.body.accepts[0] as PaymentRequirements;
  const before = { reader: bal(readerMaker), orig: bal(orig), mid: bal(midMaker), deep: bal(deepMaker), top: bal(topMaker) };
  const r = await pay('top-agent', req);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const slots = q.body.network.slots;
  assert.equal(bal(readerMaker) - before.reader, BigInt(slots[0].maker));
  assert.equal(bal(orig) - before.orig, BigInt(slots[0].royalty));
  assert.equal(bal(midMaker) - before.mid, BigInt(slots[1].maker));
  assert.equal(bal(deepMaker) - before.deep, BigInt(slots[2].maker));
  const receipt = r.body.receipt;
  assert.equal(receipt.depth, 1);
  assert.equal(receipt.hires, q.body.network.hiresTotal);
  assert.equal(receipt.total, Number(req.maxAmountRequired));
  const key = (await api.req('/api/receipts/key')).body;
  assert.match(key.messageWithHires, /^fabrica-receipt:v4\|/);
  assert.equal(verifyReceipt(key.publicKey, receipt), true);
  assert.equal(r.body.tree, `${e.cfg.siteUrl}/api/receipts/${receipt.id}/tree`);
  const tree = (await api.req(`/api/receipts/${receipt.id}/tree`)).body;
  assert.equal(tree.root.id, receipt.id);
  assert.deepEqual(tree.nodes.map((n: any) => [n.agent.slug, n.depth, n.calls.length, n.calls[0]?.status]), [
    ['reader-agent', 2, 1, 'ok'],
    ['mid-agent', 2, 1, 'ok'],
    ['deep-helper', 3, 1, 'ok'],
  ]);
  assert.equal(tree.nodes[0].paid.makerTo, readerMaker.address);
  assert.equal(tree.nodes[0].paid.royaltyTo, orig.address);
  // Every hired call's receipt is signed, linked to the run that hired it, and found from any node of the tree.
  const deep = tree.receipts.find((x: any) => x.agentSlug === 'deep-helper');
  const mid = tree.receipts.find((x: any) => x.agentSlug === 'mid-agent');
  assert.equal(deep.parentId, mid.id, 'the level-three call hangs off the call that hired it');
  assert.equal(mid.parentId, receipt.id);
  for (const h of tree.receipts) assert.equal(verifyReceipt(key.publicKey, h), true, h.id);
  assert.equal((await api.req(`/api/receipts/${deep.id}/tree`)).body.root.id, receipt.id);
  const one = (await api.req(`/api/receipts/${deep.id}`)).body;
  assert.equal(one.receipt.rootId, receipt.id);
  // Pages: the hired agent shows who hires it and what hiring earned; the top agent counts the paid slots it used.
  const readerPage = (await api.req('/api/agents/reader-agent')).body;
  assert.deepEqual(readerPage.hiredBy.map((x: any) => x.slug).sort(), ['flaky-top', 'top-agent']);
  assert.equal(readerPage.hireEarnings.slots, 1);
  assert.equal(readerPage.hireEarnings.makerMicros, slots[0].maker);
  assert.equal(readerPage.stats.paidCalls, 0, 'a hired call is not a paid call of the hired agent');
  const topPage = (await api.req('/api/agents/top-agent')).body;
  assert.deepEqual(topPage.network.used, { paid: 2, ran: 2 });
  const trees = (await api.req('/api/agents/top-agent/trees')).body.trees;
  assert.equal(trees[0].root.id, receipt.id);
});

test('refused before anyone pays: hires over the budget, a loop through another maker, a payment that leaves a hired maker out', async () => {
  setSpec('reader-agent', { makerFee: 400_000 });
  const over = await quote('top-agent');
  assert.equal(over.status, 409);
  assert.equal(over.body.error, 'over_budget');
  assert.match(over.body.message, /Nothing was charged/);
  assert.match((await api.req('/api/agents/top-agent')).body.network.problem, /more than the/);
  setSpec('reader-agent', { makerFee: 6_000 });
  setSpec('mid-agent', { tools: tools([{ slug: 'top-agent', calls: 1 }]) });
  const loop = await quote('top-agent');
  assert.equal(loop.status, 409);
  assert.equal(loop.body.error, 'cycle');
  // A level-three agent that hires is one level too many.
  setSpec('mid-agent', { tools: tools([{ slug: 'deep-helper', calls: 1 }]) });
  setSpec('deep-helper', { tools: tools([{ slug: 'note-reader', calls: 1 }]), limits });
  assert.equal((await quote('top-agent')).body.error, 'too_deep');
  setSpec('deep-helper', { tools: {}, limits: { maxSteps: 1, maxOutputTokens: 700, maxInputChars: 6000 } });
  const q = await quote('top-agent');
  const req = q.body.accepts[0] as PaymentRequirements;
  const short = { ...req, extra: { ...req.extra, recipients: req.extra.recipients.filter((r) => r.address !== deepMaker.address) } };
  const bad = await api.req('/api/agents/top-agent/run', { body: { input }, headers: { 'x-payment': await payHeader(e, short, buyer.kp) } });
  assert.equal(bad.status, 402);
  assert.equal(bad.body.error, 'recipient');
  assert.equal(e.payments.quote(req.extra.nonce)?.claimed_sig, null, 'the quote stays unused');
});

test('paused hires: left out of a new quote, but a hire already paid for still runs', async () => {
  e.setAgentPaused('mid-agent', true, 'maintenance', 'test');
  const q = await quote('top-agent');
  assert.equal(q.status, 402);
  assert.deepEqual(q.body.network.slots.map((s: any) => s.agent), ['reader-agent']);
  assert.deepEqual(q.body.network.leftOut, [{ parent: 0, slug: 'mid-agent', reason: 'paused' }]);
  const r = await pay('top-agent', q.body.accepts[0]);
  assert.equal(r.status, 200);
  const tree = (await api.req(`/api/receipts/${r.body.receipt.id}/tree`)).body;
  assert.deepEqual(tree.nodes.map((n: any) => n.agent.slug), ['reader-agent'], 'nobody paid for the paused agent');
  e.setAgentPaused('mid-agent', false, null, 'test');
  // Paid first, paused after: the hire was paid for, so it runs.
  const q2 = await quote('top-agent');
  e.setAgentPaused('mid-agent', true, 'maintenance', 'test');
  const r2 = await pay('top-agent', q2.body.accepts[0]);
  assert.equal(r2.status, 200);
  const t2 = (await api.req(`/api/receipts/${r2.body.receipt.id}/tree`)).body;
  assert.equal(t2.nodes.find((n: any) => n.agent.slug === 'mid-agent').calls[0].status, 'ok');
  e.setAgentPaused('mid-agent', false, null, 'test');
});

test('a failed run gets a retry token; the retry runs the whole job again on the same paid plan', async () => {
  const q = await quote('flaky-top');
  const r = await pay('flaky-top', q.body.accepts[0]);
  assert.equal(r.status, 502, JSON.stringify(r.body));
  assert.ok(r.body.retryToken);
  const again = await api.req('/api/agents/flaky-top/run', { body: { input }, headers: { 'x-fabrica-retry': r.body.retryToken } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const tree = (await api.req(`/api/receipts/${r.body.receipt.id}/tree`)).body;
  assert.deepEqual(tree.nodes[0].calls.map((c: any) => c.attempt), [1, 2]);
  const key = (await api.req('/api/receipts/key')).body;
  assert.equal(verifyReceipt(key.publicKey, again.body.receipt), true);
});

test('MCP: tools that hire say so, carry their network, and a paid result links its receipt tree', async () => {
  const list = (await api.req('/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).body.result.tools;
  const top = list.find((t: any) => t.name === 'run_top_agent');
  assert.match(top.description, /Hires Reader Agent and Mid Agent/);
  assert.equal(top._meta['fabrica/network'].budget, 300_000);
  assert.ok(!list.find((t: any) => t.name === 'run_plain_agent')._meta['fabrica/network']);
  const q = (await api.req('/mcp', { body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_top_agent', arguments: input } } })).body.result;
  assert.equal(q.isError, true);
  assert.equal(q._meta['fabrica/network'].slots.length, 3);
  const header = await payHeader(e, q.structuredContent.accepts[0], buyer.kp);
  const paid = (await api.req('/mcp', { body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_top_agent', arguments: { ...input, payment: header } } } })).body.result;
  assert.ok(!paid.isError, JSON.stringify(paid));
  assert.match(paid._meta.receiptTree, /\/api\/receipts\/r_[A-Za-z0-9_-]{12}\/tree$/);
});

test('the build flow: a hire list of live agents only, the four network safety tests, a price with the hires, publish', async () => {
  const cookie = await signInHttp(api, builder.kp);
  const poll = async (id: string, until: (d: any) => boolean) => {
    for (let i = 0; i < 300; i++) {
      const d = (await api.req(`/api/drafts/${id}`, { cookie })).body;
      if (until(d)) return d;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error('draft never got there');
  };
  const sentence = 'Checks meeting notes by hiring a reader agent, then writes a short verdict';
  const q = await api.req('/api/build', { body: { sentence }, cookie });
  const paid = await api.req('/api/build', { body: { sentence }, cookie, headers: { 'x-payment': await payHeader(e, q.body.accepts[0], builder.kp) } });
  const id = paid.body.draftId;
  const d = await poll(id, (x) => x.status === 'spec');
  const save = (agents: { slug: string; calls: number }[], budget = 100_000) => api.req(`/api/drafts/${id}/spec`, { method: 'PUT', body: { spec: { ...d.spec, tools: { ...d.spec.tools, hire_agent: { agents, budget } } } }, cookie });
  const ex = await save([{ slug: 'invoice-reader', calls: 1 }]);
  assert.equal(ex.status, 400);
  assert.match(ex.body.message, /example; examples take no paid calls/);
  assert.match((await save([{ slug: d.spec.slug, calls: 1 }])).body.message, /can not hire itself/);
  assert.match((await save([{ slug: 'no-such-agent', calls: 1 }])).body.message, /no live agent called no-such-agent/);
  assert.match((await save([{ slug: 'reader-agent', calls: 1 }], 1_000)).body.message, /more than the/);
  const ok = await save([{ slug: 'reader-agent', calls: 1 }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.draft.network.hiresTotal > 0);
  assert.equal(ok.body.draft.price.total, ok.body.draft.price.maker + ok.body.draft.price.ai + ok.body.draft.price.platform + ok.body.draft.price.hires);
  await api.req(`/api/drafts/${id}/tests`, { body: {}, cookie });
  const t = await poll(id, (x) => x.status === 'tests');
  await api.req(`/api/drafts/${id}/run`, { body: {}, cookie });
  const run = await poll(id, (x) => x.status === 'tested');
  const ids = run.run.results.map((x: any) => x.id);
  for (const s of ['safety-hire-takeover', 'safety-hire-overspend', 'safety-hire-loop', 'safety-hire-paused']) assert.ok(ids.includes(s), `${s} in ${ids.join(', ')}`);
  assert.equal(run.run.publishable, true, JSON.stringify(run.run.results.filter((x: any) => !x.pass)));
  assert.ok(t.tests.length > 0);
  // A hired agent paused after the tests: publishing waits.
  e.setAgentPaused('reader-agent', true, 'maintenance', 'test');
  const held = await api.req(`/api/drafts/${id}/publish`, { body: {}, cookie });
  assert.equal(held.status, 409);
  assert.match(held.body.message, /paused/);
  e.setAgentPaused('reader-agent', false, null, 'test');
  const pub = await api.req(`/api/drafts/${id}/publish`, { body: {}, cookie });
  assert.equal(pub.status, 201, JSON.stringify(pub.body));
  assert.deepEqual(pub.body.network.hires.map((h: any) => h.slug), ['reader-agent']);
  assert.equal((await quote(pub.body.slug, { request: 'Notes: we ship Friday.' })).status, 402);
});

test('NETWORKS=off: agents that hire take no new quotes and no hire lists are saved; every other agent works', async () => {
  const off = makeEngine({ env: { NETWORKS: 'off' } });
  const offApi = await serveApi(off.e);
  try {
    addLiveAgent(off.e, readerMaker.address, { name: 'Reader Agent', slug: 'reader-agent' });
    addLiveAgent(off.e, topMaker.address, { name: 'Top Agent', slug: 'top-agent', tools: tools([{ slug: 'reader-agent', calls: 1 }]), limits });
    addLiveAgent(off.e, topMaker.address, { name: 'Plain Agent', slug: 'plain-agent' });
    const r = await offApi.req('/api/agents/top-agent/run', { body: { input } });
    assert.equal(r.status, 503);
    assert.match(r.body.message, /paused for now. Nothing was charged/);
    assert.equal((await offApi.req('/api/agents/plain-agent/run', { body: { input } })).status, 402);
    assert.equal((await offApi.req('/api/health')).body.switches.networks, 'off');
    assert.equal((await offApi.req('/api/config')).body.networksOpen, false);
    assert.equal(off.e.networks.problems(off.e.agents.spec(off.e.agents.row('top-agent')!), { selfSlug: 'x', maker: null })[0].includes('paused'), true);
  } finally {
    await offApi.close();
  }
});
