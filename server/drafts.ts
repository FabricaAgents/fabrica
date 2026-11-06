// The build flow: a paid draft goes from sentence to spec, to tests, to a test run, to a live agent.
// Every AI step is charged against the draft's own budget, which the maker's build fee paid for.
import { createHash, randomBytes } from 'node:crypto';
import type { AgentSpec, RemixParent, TestCase, TestResult, TestRunSummary } from '../shared/types';
import { aiCeilingMicros, BUILDER_MODEL, modelById } from '../shared/models';
import { audit, tx, type DB } from './db';
import type { Provider } from './ai/types';
import { generateSpec } from './spec/generate';
import { normalizeSpec, SpecError } from './spec/schema';
import { generateTests, makerTest, type OriginalShape } from './suite/generate';
import { generateRemix, remixProblems } from './remix';
import { REMIX_ROYALTY_BPS } from '../shared/remix';
import { safetyTests } from './suite/safety';
import { runSuite, summarize } from './suite/runner';
import type { ToolIO } from './tools';
import type { FileStore } from './tools/files';
import type { SpendLedger } from './safety/limits';
import { runSummary, type TestRunRow } from './agents';

export type DraftStatus = 'spec_pending' | 'spec' | 'tests_pending' | 'tests' | 'running' | 'tested' | 'published' | 'failed';

export interface DraftRow {
  id: string;
  maker: string;
  sentence: string;
  spec: string | null;
  tests: string | null;
  status: DraftStatus;
  fee_sig: string | null;
  ai_spent: number;
  ai_budget: number;
  runs_used: number;
  last_run_id: string | null;
  agent_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  /** For a remix: the agent it remixes. */
  parent_id: string | null;
  /** For a remix: JSON {before, summary}, the original's spec as it was when the remix was paid for. */
  remix: string | null;
}

export interface RemixView {
  parent: RemixParent;
  before: AgentSpec;
  summary: string | null;
  /** The royalty the remix will pay per call once live, and the lowest maker part it may charge. */
  royaltyBps: number;
  feeFloor: number;
}

export interface DraftView {
  id: string;
  sentence: string;
  status: DraftStatus;
  spec: AgentSpec | null;
  tests: TestCase[];
  aiSpent: number;
  aiBudget: number;
  runsUsed: number;
  run: (TestRunSummary & { results: TestResult[]; progress: { done: number; total: number } | null }) | null;
  specHashTested: boolean;
  agentSlug: string | null;
  error: string | null;
  createdAt: number;
  remix: RemixView | null;
}

export const MAX_RUNS_PER_FEE = 3;
const SPEC_COST_GUESS = 15_000;
const TESTS_COST_GUESS = 20_000;

/** The parts of a spec that change behaviour. Price, wording and examples can change without a new test run. */
export function behaviourHash(spec: AgentSpec, tests: TestCase[]): string {
  const b = { systemPrompt: spec.systemPrompt, model: spec.model, tools: spec.tools, input: spec.input, output: spec.output, limits: spec.limits, tests: tests.filter((t) => t.enabled || t.required).map((t) => t.id + JSON.stringify(t.input) + JSON.stringify(t.checks)) };
  return createHash('sha256').update(JSON.stringify(b)).digest('hex').slice(0, 32);
}

export interface DraftDeps {
  db: DB;
  provider: () => Provider;
  io: () => ToolIO;
  files: FileStore | null;
  ledger: SpendLedger;
}

export class Drafts {
  private progress = new Map<string, { done: number; total: number; results: TestResult[] }>();
  constructor(private d: DraftDeps) {}

  row(id: string): DraftRow | null {
    return (this.d.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftRow | undefined) ?? null;
  }

  forMaker(maker: string): DraftRow[] {
    return this.d.db.prepare("SELECT * FROM drafts WHERE maker = ? AND status != 'published' ORDER BY updated_at DESC LIMIT 20").all(maker) as unknown as DraftRow[];
  }

  view(r: DraftRow): DraftView {
    const spec = r.spec ? (JSON.parse(r.spec) as AgentSpec) : null;
    const tests = r.tests ? (JSON.parse(r.tests) as TestCase[]) : [];
    const run = r.last_run_id ? (this.d.db.prepare('SELECT * FROM test_runs WHERE id = ?').get(r.last_run_id) as TestRunRow | undefined) : undefined;
    const live = run ? this.progress.get(run.id) : undefined;
    return {
      id: r.id,
      sentence: r.sentence,
      status: r.status,
      spec,
      tests,
      aiSpent: r.ai_spent,
      aiBudget: r.ai_budget,
      runsUsed: r.runs_used,
      run: run ? { ...runSummary(run), results: live ? live.results.filter(Boolean) : JSON.parse(run.results), progress: live ? { done: live.done, total: live.total } : null } : null,
      specHashTested: Boolean(run && spec && run.spec_hash === behaviourHash(spec, tests) && run.status === 'done'),
      agentSlug: r.agent_id ? ((this.d.db.prepare('SELECT slug FROM agents WHERE id = ?').get(r.agent_id) as { slug: string } | undefined)?.slug ?? null) : null,
      error: r.error,
      createdAt: r.created_at,
      remix: this.remixView(r),
    };
  }

  /** The remix terms for a draft, read fresh: the parent's maker decides whether a royalty applies. */
  remixView(r: DraftRow): RemixView | null {
    if (!r.parent_id || !r.remix) return null;
    const stored = JSON.parse(r.remix) as { before: AgentSpec; summary: string | null };
    const p = this.d.db.prepare('SELECT slug, maker, example, spec FROM agents WHERE id = ?').get(r.parent_id) as { slug: string; maker: string | null; example: number; spec: string } | undefined;
    const paysRoyalty = Boolean(p?.maker && p.maker !== r.maker);
    return {
      parent: { slug: p?.slug ?? '', name: stored.before.name, maker: p?.maker ?? null, example: Boolean(p?.example) },
      before: stored.before,
      summary: stored.summary,
      royaltyBps: paysRoyalty ? REMIX_ROYALTY_BPS : 0,
      // No floor against an example or against yourself: nobody is undercut.
      feeFloor: paysRoyalty ? stored.before.makerFee : 0,
    };
  }

  /** The titles of the original's task tests, which the remix's new tests follow in shape. */
  private originalShape(r: DraftRow): OriginalShape | undefined {
    if (!r.parent_id || !r.remix) return undefined;
    const run = this.d.db.prepare('SELECT t.results FROM agents a JOIN test_runs t ON t.id = a.test_run_id WHERE a.id = ?').get(r.parent_id) as { results: string } | undefined;
    const results = run ? (JSON.parse(run.results) as TestResult[]) : [];
    return { name: (JSON.parse(r.remix) as { before: AgentSpec }).before.name, tasks: results.filter((t) => t.kind === 'task').map((t) => t.title).slice(0, 8) };
  }

  private set(id: string, fields: Partial<DraftRow>) {
    const keys = Object.keys(fields);
    this.d.db.prepare(`UPDATE drafts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => (fields as any)[k]), Date.now(), id);
  }

  private spend(id: string, micros: number) {
    if (micros <= 0) return;
    this.d.db.prepare('UPDATE drafts SET ai_spent = ai_spent + ? WHERE id = ?').run(micros, id);
    this.d.ledger.add(`draft:${id}`, micros);
  }

  private room(id: string, micros: number): boolean {
    const r = this.row(id);
    if (!r) return false;
    if (r.ai_spent + micros > r.ai_budget) return false;
    return this.d.ledger.room(`draft:${id}`, micros, r.ai_budget).ok;
  }

  create(maker: string, sentence: string, feeSig: string | null, budget: number, fromAgent?: { id: string; spec: AgentSpec; tests: TestCase[] }, remixOf?: { id: string; spec: AgentSpec }): string {
    const id = `d_${randomBytes(9).toString('base64url')}`;
    const t = Date.now();
    this.d.db
      .prepare('INSERT INTO drafts (id, maker, sentence, spec, tests, status, fee_sig, ai_budget, agent_id, parent_id, remix, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        maker,
        sentence,
        fromAgent ? JSON.stringify(fromAgent.spec) : null,
        fromAgent ? JSON.stringify(fromAgent.tests) : null,
        fromAgent ? (fromAgent.tests.length ? 'tests' : 'spec') : 'spec_pending',
        feeSig,
        budget,
        fromAgent?.id ?? null,
        remixOf?.id ?? null,
        remixOf ? JSON.stringify({ before: remixOf.spec, summary: null }) : null,
        t,
        t,
      );
    return id;
  }

  addBudget(id: string, micros: number, feeSig: string) {
    this.d.db.prepare('UPDATE drafts SET ai_budget = ai_budget + ?, runs_used = 0, fee_sig = ?, error = NULL, updated_at = ? WHERE id = ?').run(micros, feeSig, Date.now(), id);
  }

  /** Writes the spec from the sentence. Awaitable; the HTTP layer starts it in the background. */
  async buildSpec(id: string): Promise<void> {
    const r = this.row(id);
    if (!r) return;
    if (!this.room(id, SPEC_COST_GUESS)) {
      this.set(id, { status: 'failed', error: 'The AI budget for this draft is used up. Add a round to continue.' });
      return;
    }
    this.set(id, { status: 'spec_pending', error: null });
    try {
      if (r.parent_id && r.remix) {
        // A remix rewrites only what its sentence changes, starting from the original as it was when paid for.
        const stored = JSON.parse(r.remix) as { before: AgentSpec };
        const { spec, summary, costMicros } = await generateRemix(this.d.provider(), stored.before, r.sentence, id);
        this.spend(id, costMicros);
        this.set(id, { spec: JSON.stringify(spec), tests: null, status: 'spec', remix: JSON.stringify({ ...stored, summary }) });
        return;
      }
      const { spec, costMicros } = await generateSpec(this.d.provider(), r.sentence, id);
      this.spend(id, costMicros);
      this.set(id, { spec: JSON.stringify(spec), tests: null, status: 'spec' });
    } catch (e) {
      this.set(id, { status: r.spec ? 'spec' : 'failed', error: e instanceof SpecError ? `The builder could not write a valid spec: ${e.problems.join('; ')}` : `The builder failed: ${(e as Error).message}` });
    }
  }

  saveSpec(id: string, raw: unknown): AgentSpec {
    const r = this.row(id);
    if (!r || r.status === 'published') throw new SpecError(['this draft cannot be edited']);
    if (r.status === 'running' || r.status === 'spec_pending' || r.status === 'tests_pending') throw new SpecError(['wait for the current step to finish']);
    const spec = normalizeSpec(raw);
    const remix = this.remixView(r);
    if (remix) {
      const problems = remixProblems(remix.before, spec, remix.feeFloor);
      if (problems.length) throw new SpecError(problems);
    }
    // Tests written for the old input fields no longer fit after an input change; keep them only if they still validate.
    let tests = r.tests ? (JSON.parse(r.tests) as TestCase[]) : null;
    const old = r.spec ? (JSON.parse(r.spec) as AgentSpec) : null;
    if (tests && old && (JSON.stringify(old.input) !== JSON.stringify(spec.input) || JSON.stringify(Object.keys(old.tools).sort()) !== JSON.stringify(Object.keys(spec.tools).sort()))) tests = null;
    this.set(id, { spec: JSON.stringify(spec), tests: tests ? JSON.stringify(tests) : null, status: tests ? (r.last_run_id ? 'tested' : 'tests') : 'spec' });
    return spec;
  }

  async buildTests(id: string): Promise<void> {
    const r = this.row(id);
    if (!r?.spec) return;
    if (!this.room(id, TESTS_COST_GUESS)) {
      this.set(id, { error: 'The AI budget for this draft is used up. Add a round to continue.' });
      return;
    }
    this.set(id, { status: 'tests_pending', error: null });
    const spec = JSON.parse(r.spec) as AgentSpec;
    try {
      const { tests, costMicros } = await generateTests(this.d.provider(), spec, id, this.originalShape(r));
      this.spend(id, costMicros);
      this.set(id, { tests: JSON.stringify(tests), status: 'tests' });
    } catch (e) {
      this.set(id, { status: 'spec', error: (e as Error).message });
    }
  }

  editTests(id: string, body: { enabled?: Record<string, boolean>; add?: { title: string; input: unknown; mustContain?: string[] }[]; remove?: string[] }): TestCase[] {
    const r = this.row(id);
    if (!r?.spec || !r.tests) throw new SpecError(['there are no tests to edit yet']);
    if (r.status === 'running') throw new SpecError(['wait for the test run to finish']);
    const spec = JSON.parse(r.spec) as AgentSpec;
    let tests = JSON.parse(r.tests) as TestCase[];
    for (const t of tests) if (!t.required && body.enabled && t.id in body.enabled) t.enabled = Boolean(body.enabled[t.id]);
    if (body.remove?.length) tests = tests.filter((t) => t.required || !(t.id.startsWith('maker-') && body.remove!.includes(t.id)));
    let n = tests.filter((t) => t.id.startsWith('maker-')).length;
    for (const a of body.add ?? []) {
      if (tests.length >= 20) throw new SpecError(['a suite holds at most 20 tests']);
      tests.push(makerTest(spec, ++n, String(a.title ?? ''), a.input, (a.mustContain ?? []).map(String).filter(Boolean)));
    }
    this.set(id, { tests: JSON.stringify(tests) });
    return tests;
  }

  /** Starts a test run. Resolves when it finishes; callers that should not wait can ignore the promise. */
  async runTests(id: string): Promise<string | null> {
    const r = this.row(id);
    if (!r?.spec || !r.tests) throw new SpecError(['write the tests first']);
    if (r.status === 'running') throw new SpecError(['a test run is already going']);
    if (r.runs_used >= MAX_RUNS_PER_FEE) throw new SpecError([`a build round covers ${MAX_RUNS_PER_FEE} test runs; add a round to run again`]);
    const spec = JSON.parse(r.spec) as AgentSpec;
    let tests = JSON.parse(r.tests) as TestCase[];
    // The safety tests always follow the current spec, so a tool added after the tests were written is covered.
    const fixed = safetyTests(spec, tests.find((t) => t.kind === 'task')?.input ?? spec.examples[0]?.input);
    tests = [...tests.filter((t) => !t.required && t.kind !== 'robustness'), ...fixed];
    const model = modelById(spec.model)!;
    const need = aiCeilingMicros(model, spec.limits.maxSteps, spec.limits.maxOutputTokens) * Math.min(tests.length, 4);
    if (!this.room(id, need)) throw new SpecError(['the AI budget for this draft is used up; add a round to continue']);
    const runId = `t_${randomBytes(9).toString('base64url')}`;
    const hash = behaviourHash(spec, tests);
    tx(this.d.db, () => {
      this.d.db.prepare('INSERT INTO test_runs (id, draft_id, spec_hash, model, status, started_at) VALUES (?, ?, ?, ?, ?, ?)').run(runId, id, hash, spec.model, 'running', Date.now());
      this.set(id, { tests: JSON.stringify(tests), status: 'running', last_run_id: runId, runs_used: r.runs_used + 1, error: null });
    });
    const enabled = tests.filter((t) => t.enabled || t.required);
    const prog = { done: 0, total: enabled.length, results: [] as TestResult[] };
    this.progress.set(runId, prog);
    try {
      const results = await runSuite(spec, tests, {
        provider: this.d.provider(),
        io: this.d.io(),
        files: this.d.files,
        ownerRef: runId,
        onSpend: (m) => this.spend(id, m),
        canSpend: (m) => this.room(id, m),
        onResult: (res, done) => {
          prog.done = done;
          prog.results.push(res);
        },
      });
      const s = summarize(results);
      this.d.db
        .prepare('UPDATE test_runs SET status = ?, total = ?, passed = ?, safety_total = ?, safety_passed = ?, task_total = ?, task_passed = ?, score = ?, publishable = ?, results = ?, ai_cost = ?, finished_at = ? WHERE id = ?')
        .run('done', s.total, s.passed, s.safetyTotal, s.safetyPassed, s.taskTotal, s.taskPassed, s.score, s.publishable ? 1 : 0, JSON.stringify(results), s.aiCostMicros, Date.now(), runId);
      this.set(id, { status: 'tested' });
    } catch (e) {
      this.d.db.prepare('UPDATE test_runs SET status = ?, finished_at = ? WHERE id = ?').run('failed', Date.now(), runId);
      this.set(id, { status: 'tests', error: `The test run failed: ${(e as Error).message}` });
    } finally {
      this.progress.delete(runId);
    }
    return runId;
  }

  markPublished(id: string, agentId: string) {
    this.set(id, { status: 'published', agent_id: agentId });
    audit(this.d.db, 'maker', 'publish', { draft: id, agent: agentId });
  }

  /** Drafts left mid-step by a restart go back to the last stable state. */
  recover() {
    this.d.db.prepare("UPDATE drafts SET status = 'failed', error = 'Interrupted by a restart. Try again.' WHERE status = 'spec_pending' AND spec IS NULL").run();
    this.d.db.prepare("UPDATE drafts SET status = 'spec', error = 'Interrupted by a restart. Try again.' WHERE status IN ('spec_pending', 'tests_pending') AND spec IS NOT NULL").run();
    this.d.db.prepare("UPDATE drafts SET status = 'tests', runs_used = MAX(runs_used - 1, 0), error = 'The test run was interrupted by a restart. It did not count.' WHERE status = 'running'").run();
    this.d.db.prepare("UPDATE test_runs SET status = 'failed', finished_at = ? WHERE status = 'running'").run(Date.now());
  }
}

export { BUILDER_MODEL };
