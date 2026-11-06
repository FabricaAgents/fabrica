import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox } from '../../server/tools/sandbox';

test('runs code and returns output and value', async () => {
  const r = await runInSandbox('console.log("hi", INPUT.n); INPUT.n * 2', { input: { n: 21 } });
  assert.equal(r.ok, true);
  assert.equal(r.stdout, 'hi 21\n');
  assert.equal(r.value, '42');
});

test('an endless loop is stopped at the time limit', async () => {
  const t = Date.now();
  const r = await runInSandbox('while (true) {}', { timeMs: 300 });
  assert.equal(r.ok, false);
  assert.match(r.error!, /time limit/);
  assert.ok(Date.now() - t < 4000);
});

test('memory is capped', async () => {
  const r = await runInSandbox('let a = []; while (true) a.push(new Array(1e5).fill(1));', { memoryMb: 8, timeMs: 1500 });
  assert.equal(r.ok, false);
});

test('there is no host: no process, require, fetch, files or timers', async () => {
  const r = await runInSandbox('[typeof process, typeof require, typeof fetch, typeof setTimeout, typeof fetch_text, typeof globalThis.Deno].join(",")');
  assert.equal(JSON.parse(r.value!), 'undefined,undefined,undefined,undefined,undefined,undefined');
});

test('the network exists only for allowed domains and goes through the guard', async () => {
  const seen: string[] = [];
  const fetcher = async (url: string, allow: string[]) => {
    seen.push(url);
    if (!allow.some((d) => new URL(url).hostname.endsWith(d))) throw new Error('not on this agent’s list');
    return 'ok body';
  };
  const ok = await runInSandbox('fetch_text("https://api.example.com/x")', { network: ['example.com'], fetcher });
  assert.equal(JSON.parse(ok.value!), 'ok body');
  const bad = await runInSandbox('fetch_text("https://evil.test/")', { network: ['example.com'], fetcher });
  assert.equal(bad.ok, false);
  const many = await runInSandbox('for (let i = 0; i < 5; i++) fetch_text("https://example.com/")', { network: ['example.com'], fetcher });
  assert.match(many.error!, /at most 3/);
  assert.equal(seen.length, 1 + 1 + 3);
});

test('oversized code is refused', async () => {
  const r = await runInSandbox('1;'.repeat(20_001));
  assert.equal(r.ok, false);
});
