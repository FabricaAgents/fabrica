// The first real test, for the owner to run once OPENROUTER_API_KEY is set. It spends real money, so it prints
// the most it can cost and does nothing unless run with --yes.
//
//   OPENROUTER_API_KEY=... npm run real-test            (prints the plan and the cost ceiling)
//   OPENROUTER_API_KEY=... npm run real-test -- --yes   (runs it)
//
// What it does: builds one new agent from a sentence with the real builder model (spec, tests), runs its full
// suite on its real model with live web reads, and then re-tests the seven example agents on real models, so the
// examples could later be published as real agents. It touches no wallet and moves no money on chain.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aiCeilingMicros, BUILDER_MODEL, MODELS, modelById } from '../shared/models';
import { OpenRouterProvider, refreshPrices } from '../server/ai/openrouter';
import { generateSpec } from '../server/spec/generate';
import { generateTests } from '../server/suite/generate';
import { runSuite, summarize } from '../server/suite/runner';
import { liveIO } from '../server/tools';
import { HttpRpc } from '../server/solana/rpc';
import { FileStore } from '../server/tools/files';
import { openMemoryDb } from '../server/db';
import { normalizeSpec } from '../server/spec/schema';
import { EXAMPLES } from '../fixtures/examples/index';
import { testHandle } from '../server/networks';
import { usd } from '../shared/format';

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error('Set OPENROUTER_API_KEY first.');
  process.exit(1);
}
const yes = process.argv.includes('--yes');
const SENTENCE = process.argv.slice(2).find((a) => !a.startsWith('-') && a.length > 20) ?? 'Reads a public web page and lists every outbound link with its anchor text, grouped by domain';
const base = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
await refreshPrices(MODELS, base).catch(() => 0);

// The ceiling: builder calls, then every test at its per-call AI ceiling, plus judge calls.
const builder = modelById(BUILDER_MODEL)!;
const builderCall = (inTok: number, outTok: number) => Math.ceil(inTok * builder.inPerM + outTok * builder.outPerM);
const newAgentCeiling = 2 * builderCall(4000, 3000) + 2 * builderCall(3000, 3500) + 14 * aiCeilingMicros(builder, 4, 900) + 6 * builderCall(2000, 200);
// The examples as they are built: an example that hires (Invoice Check) hires the other examples in its tests.
const exSpecs = new Map(EXAMPLES.map((fx) => normalizeSpec(fx.spec)).map((s) => [s.slug, s]));
const find = (slug: string) => {
  const s = exSpecs.get(slug);
  return s ? { id: `x_${slug}`, slug, spec: s, version: 1, status: 'example', example: true, maker: null, royalty: { bps: 0, wallet: null } } : null;
};
const ceilingOf = (s: ReturnType<typeof normalizeSpec>) => aiCeilingMicros(modelById(s.model)!, s.limits.maxSteps, s.limits.maxOutputTokens);
const exampleCeiling = EXAMPLES.reduce((n, fx) => {
  const s = normalizeSpec(fx.spec);
  const hires = (s.tools.hire_agent?.agents ?? []).reduce((k, h) => k + h.calls * (exSpecs.get(h.slug) ? ceilingOf(exSpecs.get(h.slug)!) : 0), 0);
  return n + (fx.tests.tests.length + (s.tools.hire_agent ? 10 : 6)) * (ceilingOf(s) + hires) + 2 * builderCall(2000, 200);
}, 0);
console.log(`Plan
  1. Build one agent from: "${SENTENCE}"
     builder model ${BUILDER_MODEL}; at most ${usd(newAgentCeiling)}
  2. Re-test the ${EXAMPLES.length} example agents on their own models; at most ${usd(exampleCeiling)}
  Ceiling for the whole run: ${usd(newAgentCeiling + exampleCeiling)}. Real runs use a fraction of their ceiling; expect about a third.
  Nothing on chain is touched and no wallet is used.`);
if (!yes) {
  console.log('\nNothing was run. Add --yes to run it.');
  process.exit(0);
}

const provider = new OpenRouterProvider(key, base, 'https://fabrica.fun');
const db = openMemoryDb();
const files = new FileStore(db, fs.mkdtempSync(path.join(os.tmpdir(), 'fab-real-')), 'https://fabrica.fun');
const io = liveIO(new HttpRpc([process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : 'https://api.mainnet-beta.solana.com']));
let spent = 0;
const report: Record<string, unknown> = {};

const one = async (label: string, spec: ReturnType<typeof normalizeSpec>, tests: Awaited<ReturnType<typeof generateTests>>['tests']) => {
  const results = await runSuite(spec, tests, {
    provider,
    io,
    files,
    ownerRef: label,
    onSpend: (m) => (spent += m),
    canSpend: () => spent < newAgentCeiling + exampleCeiling,
    hires: (sp, t, spend) => testHandle(sp, t, { provider, io, files, ...spend, find, fees: { platformFeeBps: 1000, platformFeeMinMicros: 2000 }, tierOf: () => null, allowExamples: true }),
  });
  const s = summarize(results);
  report[label] = { passed: `${s.passed}/${s.total}`, publishable: s.publishable, failed: results.filter((r) => !r.pass).map((r) => `${r.id}: ${r.error ?? r.checks.filter((c) => !c.pass).map((c) => c.detail).join('; ')}`) };
  console.log(label, JSON.stringify(report[label], null, 2));
};

const { spec, costMicros: c1 } = await generateSpec(provider, SENTENCE, 'real-test');
spent += c1;
console.log('spec:', spec.name, Object.keys(spec.tools), `model ${spec.model}`);
const { tests, costMicros: c2 } = await generateTests(provider, spec, 'real-test');
spent += c2;
await one(`new:${spec.slug}`, spec, tests);
for (const fx of EXAMPLES) {
  const s = normalizeSpec(fx.spec);
  const { safetyTests } = await import('../server/suite/safety');
  const { cleanTasks } = await import('../server/suite/generate');
  const t = [...cleanTasks(s, fx.tests), ...safetyTests(s, fx.tests.tests[0]?.input)];
  await one(`example:${s.slug}`, s, t);
}
console.log(`\nSpent on AI: ${usd(spent)} (OpenRouter's own usage figures).`);
const out = path.join(process.cwd(), 'docs', `real-test-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(out, JSON.stringify({ spentMicros: spent, report }, null, 2));
console.log('Report written to', out);
