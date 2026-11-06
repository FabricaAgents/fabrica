// Builds the example agents through the real pipeline: spec writer, test writer, runner and graders, with
// recorded model replies and recorded chain and web reads. Nothing is paid, nothing is invented: what the
// site shows is what the runner and graders produced. Examples take no paid calls and show no earnings.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FakeProvider } from '../ai/fake';
import { kvGet, kvSet, tx, type DB } from '../db';
import { generateSpec } from '../spec/generate';
import { generateTests } from '../suite/generate';
import { runSuite, summarize } from '../suite/runner';
import { loadRecording, replayIO } from '../tools/replay';
import type { FileStore } from '../tools/files';
import { behaviourHash } from '../drafts';
import { EXAMPLES, exampleBrains } from '../../fixtures/examples/index';

export function fixturesVersion(fixturesDir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else h.update(f).update(fs.readFileSync(p));
    }
  };
  walk(fixturesDir);
  return h.digest('hex').slice(0, 16);
}

export interface SeedReport {
  slug: string;
  passed: number;
  total: number;
  publishable: boolean;
}

export async function seedExamples(db: DB, files: FileStore | null, fixturesDir: string, log: (m: string) => void = () => {}, force = false): Promise<SeedReport[]> {
  const version = fixturesVersion(fixturesDir);
  if (!force && kvGet(db, 'examples_version') === version && (db.prepare('SELECT COUNT(*) AS n FROM agents WHERE example = 1').get() as { n: number }).n === EXAMPLES.length) return [];
  const rec = loadRecording(fixturesDir);
  const provider = new FakeProvider(exampleBrains());
  const io = replayIO(rec);
  const reports: SeedReport[] = [];
  const built: { slug: string; spec: string; runId: string; run: any; results: string; hash: string; sentence: string }[] = [];
  for (const fx of EXAMPLES) {
    const { spec } = await generateSpec(provider, fx.sentence, `seed:${fx.slug}`);
    const { tests } = await generateTests(provider, spec, `seed:${fx.slug}`);
    const runId = `t_${randomBytes(9).toString('base64url')}`;
    const results = await runSuite(spec, tests, { provider, io, files, ownerRef: `x:${runId}`, onSpend: () => {}, canSpend: () => true });
    const s = summarize(results);
    reports.push({ slug: spec.slug, passed: s.passed, total: s.total, publishable: s.publishable });
    if (!s.publishable) log(`example ${spec.slug} did not pass its suite (${s.passed}/${s.total}); it is shown with its real results`);
    built.push({ slug: spec.slug, spec: JSON.stringify(spec), runId, run: s, results: JSON.stringify(results), hash: behaviourHash(spec, tests), sentence: fx.sentence });
  }
  const t = Date.now();
  tx(db, () => {
    const old = db.prepare('SELECT id, test_run_id FROM agents WHERE example = 1').all() as { id: string; test_run_id: string }[];
    for (const o of old) {
      db.prepare('DELETE FROM test_runs WHERE id = ?').run(o.test_run_id);
      db.prepare('DELETE FROM agents WHERE id = ?').run(o.id);
    }
    built.forEach((b, i) => {
      const s = b.run;
      db.prepare('INSERT INTO test_runs (id, spec_hash, model, status, total, passed, safety_total, safety_passed, task_total, task_passed, score, publishable, results, ai_cost, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        b.runId,
        b.hash,
        JSON.parse(b.spec).model,
        'done',
        s.total,
        s.passed,
        s.safetyTotal,
        s.safetyPassed,
        s.taskTotal,
        s.taskPassed,
        s.score,
        s.publishable ? 1 : 0,
        b.results,
        0,
        t,
        t,
      );
      // A slug taken by a maker's agent keeps the maker's; the example gets a suffix.
      let slug = b.slug;
      while (db.prepare('SELECT 1 FROM agents WHERE slug = ?').get(slug)) slug = `${b.slug}-example`;
      db.prepare('INSERT INTO agents (id, slug, maker, status, example, spec, version, test_run_id, published_at, updated_at, sentence) VALUES (?, ?, NULL, ?, 1, ?, 1, ?, ?, ?, ?)').run(`x_${b.slug}`, slug, 'example', b.spec, b.runId, t - i * 1000, t, b.sentence);
    });
    kvSet(db, 'examples_version', version);
  });
  log(`examples built: ${reports.map((r) => `${r.slug} ${r.passed}/${r.total}`).join(', ')}`);
  return reports;
}
