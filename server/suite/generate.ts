// The test suite: task tests written by a model, with checks a machine can grade, plus the fixed safety tests.
import { BUILDER_MODEL, modelById } from '../../shared/models';
import type { AgentSpec, Check, CheckType, TestCase } from '../../shared/types';
import { extractJson, type Provider } from '../ai/types';
import { validateInput } from '../spec/schema';
import { safetyTests } from './safety';

const TASK_CHECKS: CheckType[] = ['schema', 'equals', 'contains', 'not_contains', 'regex', 'number', 'tool_called', 'regex_matches', 'file_made', 'judge'];

export const TESTS_SYSTEM = `You write test suites for AI agents before they go on sale. You get an agent's spec. Write 5 to 7 realistic tasks a paying buyer would send, each with checks a machine can grade. Reply with one JSON object: {"tests": [...]}.

Each test: {"title": short, "input": {...exactly the agent's input fields...}, "checks": [...]}.
Prefer tasks with one correct answer (a computed number, a parsed value, a known fact read from a source), and include one edge case and one malformed or empty-ish input.
Check types:
- {"type":"schema"}: the answer fits the output contract. Add it to every test.
- {"type":"equals","path":"field","value":...}: exact value (text is compared case-insensitively).
- {"type":"number","path":"field","value":12.5,"tolerance":0.01}
- {"type":"contains","path":"field","values":["..."]}: the field (or the whole answer without path) contains every value, case-insensitive.
- {"type":"not_contains","values":["..."]}
- {"type":"regex","path":"field","pattern":"..."}: case-insensitive.
- {"type":"tool_called","tool":"web_fetch|code_run|solana_read|file_output"}: the agent used that tool successfully.
- {"type":"regex_matches","path":"field","shouldMatch":[...],"shouldNotMatch":[...]}: the field holds a regular expression that behaves this way.
- {"type":"file_made"}: the agent produced a downloadable file.
- {"type":"judge","rubric":"..."}: only when nothing else can check it; one clear yes or no question about the answer.
When the spec names an "original", the agent is a remix or a new version of it: cover the kinds of tasks the original was tested on, as they apply now, and test the change itself.
Never put secrets, private data or harmful requests in tests; safety tests are added separately.`;

function cleanCheck(c: any): Check | null {
  if (!c || !TASK_CHECKS.includes(c.type)) return null;
  const out: Check = { type: c.type };
  if (typeof c.path === 'string' && /^[a-zA-Z0-9_.]{1,80}$/.test(c.path)) out.path = c.path;
  if (c.value !== undefined) out.value = c.value;
  if (Array.isArray(c.values)) out.values = c.values.slice(0, 10).map((v: unknown) => String(v).slice(0, 200));
  if (typeof c.tolerance === 'number') out.tolerance = Math.abs(c.tolerance);
  if (typeof c.pattern === 'string') out.pattern = c.pattern.slice(0, 300);
  if (typeof c.tool === 'string') out.tool = c.tool;
  if (Array.isArray(c.shouldMatch)) out.shouldMatch = c.shouldMatch.slice(0, 10).map(String);
  if (Array.isArray(c.shouldNotMatch)) out.shouldNotMatch = c.shouldNotMatch.slice(0, 10).map(String);
  if (typeof c.rubric === 'string') out.rubric = c.rubric.slice(0, 400);
  if ((out.type === 'equals' || out.type === 'number') && out.value === undefined) return null;
  if ((out.type === 'contains' || out.type === 'not_contains') && !out.values?.length) return null;
  if (out.type === 'regex' && !out.pattern) return null;
  if (out.type === 'regex_matches' && !(out.shouldMatch?.length || out.shouldNotMatch?.length)) return null;
  if (out.type === 'judge' && !out.rubric) return null;
  if (out.type === 'regex' && out.pattern) {
    try {
      new RegExp(out.pattern, 'i');
    } catch {
      return null;
    }
  }
  return out;
}

export function cleanTasks(spec: AgentSpec, raw: unknown): TestCase[] {
  const list: any[] = Array.isArray((raw as any)?.tests) ? (raw as any).tests : Array.isArray(raw) ? (raw as any[]) : [];
  const out: TestCase[] = [];
  for (const t of list.slice(0, 8)) {
    const input = t?.input && typeof t.input === 'object' ? t.input : null;
    if (!input || validateInput(spec.input, input).length) continue;
    const checks = (Array.isArray(t.checks) ? t.checks : []).map(cleanCheck).filter(Boolean) as Check[];
    if (!checks.some((c) => c.type === 'schema')) checks.unshift({ type: 'schema' });
    out.push({
      id: `task-${out.length + 1}`,
      kind: 'task',
      title: String(t.title ?? `Task ${out.length + 1}`).slice(0, 100),
      input,
      checks: checks.slice(0, 6),
      required: false,
      enabled: true,
    });
  }
  return out;
}

/** For a remix or a new version: the name and task test titles it starts from, the shape the new tests follow. */
export interface OriginalShape {
  name: string;
  tasks: string[];
}

export async function generateTests(provider: Provider, spec: AgentSpec, ref: string, original?: OriginalShape): Promise<{ tests: TestCase[]; costMicros: number }> {
  const model = modelById(BUILDER_MODEL)!;
  const view = { name: spec.name, brief: spec.brief, tools: spec.tools, input: spec.input, output: spec.output, examples: spec.examples, ...(original ? { original } : {}) };
  let cost = 0;
  let tasks: TestCase[] = [];
  for (let attempt = 0; attempt < 2 && tasks.length < 3; attempt++) {
    const reply = await provider.complete({
      purpose: 'tests',
      ref,
      model: model.id,
      messages: [
        { role: 'system', content: TESTS_SYSTEM },
        { role: 'user', content: `Agent spec:\n${JSON.stringify(view, null, 2)}` },
      ],
      maxTokens: 3500,
      temperature: 0.3,
      jsonMode: true,
      maxPrice: { inPerM: model.inPerM, outPerM: model.outPerM },
    });
    cost += reply.costMicros || Math.ceil(reply.promptTokens * model.inPerM + reply.completionTokens * model.outPerM);
    try {
      tasks = cleanTasks(spec, extractJson(reply.text));
    } catch {
      tasks = [];
    }
  }
  if (tasks.length < 3) throw new Error('the test writer did not produce enough valid tests; try again or edit the input fields');
  return { tests: [...tasks, ...safetyTests(spec, tasks[0]?.input ?? spec.examples[0]?.input)], costMicros: cost };
}

/** A maker's own test: one input and the text the answer must contain. */
export function makerTest(spec: AgentSpec, index: number, title: string, input: unknown, mustContain: string[]): TestCase {
  const errs = validateInput(spec.input, input);
  if (errs.length) throw new Error(errs.join('; '));
  return {
    id: `maker-${index}`,
    kind: 'task',
    title: title.slice(0, 100) || 'Maker test',
    input: input as Record<string, unknown>,
    checks: [{ type: 'schema' }, ...(mustContain.length ? [{ type: 'contains' as const, values: mustContain.slice(0, 5) }] : [])],
    required: false,
    enabled: true,
  };
}
