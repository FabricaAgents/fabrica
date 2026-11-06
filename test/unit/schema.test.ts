import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpec, SpecError, validateInput, validateOutput, toJsonSchema, slugify } from '../../server/spec/schema';
import { standInSpec } from '../../server/ai/fake';
import { checkSentence } from '../../server/spec/generate';

const good = () => standInSpec('Summarise any public web page into three bullet points');

test('a model spec normalises with safe defaults', () => {
  const s = normalizeSpec(good());
  assert.equal(s.slug, slugify(s.name));
  assert.ok(s.tools.web_fetch);
  assert.ok(s.limits.maxSteps >= 2, 'tool agents get at least two steps');
  assert.ok(s.makerFee >= 1000);
});

test('unknown tools, bad field names and missing parts are refused with reasons', () => {
  const raw: any = { ...good(), tools: { shell: {} }, input: [{ name: '9 bad name!', type: 'string' }], systemPrompt: 'short' };
  assert.throws(() => normalizeSpec(raw), (e: unknown) => {
    assert.ok(e instanceof SpecError);
    assert.ok(e.problems.some((p) => p.includes('unknown tool')));
    assert.ok(e.problems.some((p) => p.includes('system prompt')));
    return true;
  });
});

test('the code runner gets network only for named domains', () => {
  assert.throws(() => normalizeSpec({ ...good(), tools: { code_run: { network: true, allowDomains: [] } } }), SpecError);
  const s = normalizeSpec({ ...good(), tools: { code_run: { network: true, allowDomains: ['https://api.example.com/x'] } } });
  assert.deepEqual(s.tools.code_run!.allowDomains, ['api.example.com']);
  assert.equal(s.tools.code_run!.network, true);
});

test('limits are clamped', () => {
  const s = normalizeSpec({ ...good(), limits: { maxSteps: 99, maxOutputTokens: 1e9, maxInputChars: 1e9 }, makerFee: 1e12 });
  assert.equal(s.limits.maxSteps, 8);
  assert.equal(s.limits.maxOutputTokens, 4000);
  assert.equal(s.makerFee, 5_000_000);
});

test('input and output validation', () => {
  const s = normalizeSpec({ ...good(), input: [{ name: 'q', type: 'string', required: true, maxLength: 5 }, { name: 'n', type: 'integer', required: false }] });
  assert.deepEqual(validateInput(s.input, { q: 'abc' }), []);
  assert.ok(validateInput(s.input, { q: 'abcdefg' })[0].includes('longer'));
  assert.ok(validateInput(s.input, { q: 'a', n: 1.5 })[0].includes('whole'));
  assert.ok(validateInput(s.input, { q: 'a', extra: 1 })[0].includes('unknown'));
  assert.ok(validateInput(s.input, [])[0].includes('object'));
  assert.ok(validateOutput(s.output, { answer: 'x' }).length > 0, 'confidence missing');
  assert.equal(validateOutput(s.output, { answer: 'x', confidence: 'high' }).length, 0);
  assert.equal((toJsonSchema(s.input) as any).required[0], 'q');
});

test('sentences are bounded', () => {
  assert.throws(() => checkSentence('too short'), SpecError);
  assert.throws(() => checkSentence('x'.repeat(401)), SpecError);
  assert.equal(checkSentence('  Reads   a page and   lists links  '), 'Reads a page and lists links');
});
