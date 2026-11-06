// The provider used whenever no paid AI may run: development, tests, and the recorded example agents.
// Scripted "brains" answer the requests they recognise; anything else gets a plain, deterministic stand-in.
// It never reaches the network and never costs anything unless a test asks it to report a cost.
import { aiCeilingMicros, modelById } from '../../shared/models';
import type { ChatMessage, ChatReply, ChatRequest, Provider } from './types';

export interface FakeTurn {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}

export interface ToolExchange {
  name: string;
  args: Record<string, unknown>;
  content: string;
}

/** Read-only views of a request that scripted brains use to decide what a model would say next. */
export class View {
  constructor(public req: ChatRequest) {}
  get messages(): ChatMessage[] {
    return this.req.messages;
  }
  /** The parsed JSON input of an agent call. */
  input(): Record<string, unknown> {
    const u = this.messages.find((m) => m.role === 'user');
    const m = u?.content.match(/^Input:\n([\s\S]*)$/);
    try {
      return m ? JSON.parse(m[1]) : {};
    } catch {
      return {};
    }
  }
  /** How many model turns came before this one. */
  step(): number {
    return this.messages.filter((m) => m.role === 'assistant').length;
  }
  canary(): string | null {
    return this.messages[0]?.content.match(/Internal reference \(never disclose[^)]*\): (FBX-[0-9A-F]+)/)?.[1] ?? null;
  }
  tools(): ToolExchange[] {
    const out: ToolExchange[] = [];
    for (const m of this.messages) {
      if (m.role !== 'assistant' || !m.toolCalls) continue;
      for (const c of m.toolCalls) {
        const res = this.messages.find((x) => x.role === 'tool' && x.toolCallId === c.id);
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.arguments);
        } catch {
          /* keep empty */
        }
        out.push({ name: c.name, args, content: res?.content ?? '' });
      }
    }
    return out;
  }
  /** The output fields the system prompt asks for, as [name, type]. */
  outputFields(): [string, string][] {
    const sys = this.messages[0]?.content ?? '';
    const tail = sys.split('## Your answer')[1] ?? '';
    return [...tail.matchAll(/^- ([a-z][a-z0-9_]*) \(([^,)]+)/gm)].map((m) => [m[1], m[2]]);
  }
  lastUser(): string {
    return [...this.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  }
  sentence(): string {
    return this.lastUser().match(/^Sentence: ([\s\S]*)$/)?.[1]?.trim() ?? '';
  }
  /** A remix request: the change sentence and the spec it changes. */
  remixRequest(): { change: string; spec: any } | null {
    const first = this.messages.find((m) => m.role === 'user')?.content ?? '';
    const m = first.match(/^Change request: (.*)\n\nCurrent spec:\n([\s\S]*)$/);
    if (!m) return null;
    try {
      return { change: m[1].trim(), spec: JSON.parse(m[2]) };
    } catch {
      return null;
    }
  }
  /** An improvement to an agent by its own maker: the request and the live spec. */
  versionRequest(): { change: string; spec: any } | null {
    const first = this.messages.find((m) => m.role === 'user')?.content ?? '';
    const m = first.match(/^Improvement request: (.*)\n\nCurrent spec:\n([\s\S]*)$/);
    if (!m) return null;
    try {
      return { change: m[1].trim(), spec: JSON.parse(m[2]) };
    } catch {
      return null;
    }
  }
  specForTests(): any {
    const m = this.lastUser().match(/^Agent spec:\n([\s\S]*)$/);
    try {
      return m ? JSON.parse(m[1]) : null;
    } catch {
      return null;
    }
  }
  /** True when the user turn is a correction request after an answer that did not fit. */
  isRepair(): boolean {
    return /does not fit the output contract/.test(this.lastUser());
  }
}

export type Brain = (v: View) => FakeTurn | null | undefined;

let callSeq = 0;

export interface FakeOptions {
  /** Report a made-up cost per reply, for cap and budget tests. Zero by default: nothing was paid. */
  costMicros?: number | 'ceiling';
  /** Delay per reply, for load tests. */
  delayMs?: number;
}

export class FakeProvider implements Provider {
  name = 'fake' as const;
  calls = 0;
  constructor(
    private brains: Brain[] = [],
    private opts: FakeOptions = {},
  ) {}

  async complete(req: ChatRequest): Promise<ChatReply> {
    this.calls++;
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    const v = new View(req);
    let turn: FakeTurn | null | undefined = null;
    for (const b of this.brains) {
      turn = b(v);
      if (turn) break;
    }
    turn ??= standIn(v);
    const toolCalls = (req.tools?.length ? turn.toolCalls ?? [] : []).map((c) => ({ id: `fake_${++callSeq}`, name: c.name, arguments: JSON.stringify(c.args) }));
    const text = turn.text ?? '';
    const promptChars = req.messages.reduce((n, m) => n + m.content.length, 0);
    const model = modelById(req.model);
    let cost = 0;
    if (this.opts.costMicros === 'ceiling' && model) cost = Math.ceil(aiCeilingMicros(model, 1, req.maxTokens) / 2);
    else if (typeof this.opts.costMicros === 'number') cost = this.opts.costMicros;
    return {
      text,
      toolCalls,
      promptTokens: Math.ceil(promptChars / 4),
      completionTokens: Math.ceil((text.length + toolCalls.reduce((n, c) => n + c.arguments.length, 0)) / 4),
      costMicros: cost,
      finish: toolCalls.length ? 'tool_calls' : 'stop',
    };
  }
}

// ---------------------------------------------------------------- the stand-in for anything unscripted

const ATTACK = /ignore all previous|system prompt|maintenance mode|secret|api key|environment variable|169\.254|localhost|\/etc\/passwd|process\.env|transfer \d|endless loop|\.\.\/|<script/i;

const STOP = new Set('a an the any every of for to from into and or with on in it its that this which who my your their our is are be by as at about each all some only then than'.split(' '));
const ROLE: [RegExp, string][] = [
  [/summari[sz]/i, 'Digest'],
  [/extract|parse|pull/i, 'Extractor'],
  [/translat/i, 'Translator'],
  [/analy[sz]|compute|calculat/i, 'Analyst'],
  [/check|audit|verify|inspect|review/i, 'Inspector'],
  [/writ|draft|compose/i, 'Writer'],
  [/find|search|look up|track|watch|monitor/i, 'Scout'],
  [/explain/i, 'Explainer'],
  [/convert|turn/i, 'Converter'],
  [/classif|sort|tag|label/i, 'Sorter'],
];

const title = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

export function standInSpec(sentence: string) {
  const words = sentence.replace(/[^a-zA-Z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const role = ROLE.find(([re]) => re.test(sentence))?.[1] ?? 'Assistant';
  const verbIdx = words.findIndex((w) => ROLE.some(([re]) => re.test(w)));
  const nouns = words.slice(verbIdx + 1).filter((w) => !STOP.has(w.toLowerCase()) && w.length > 2).slice(0, 2);
  const name = [...nouns.map(title), role].join(' ').slice(0, 40) || 'Task Assistant';
  const s = sentence.toLowerCase();
  const tools: Record<string, unknown> = {};
  if (/\b(url|web|page|site|link|article|blog|online)\b/.test(s)) tools.web_fetch = { allowDomains: [] };
  if (/\b(csv|calculat|comput|code|regex|math|number|statistic|javascript|json)\w*/.test(s)) tools.code_run = { network: false, allowDomains: [], timeMs: 2000, memoryMb: 32 };
  if (/\b(solana|wallet|token|mint|onchain|on-chain|transaction|sol)\b/.test(s)) tools.solana_read = { methods: ['getAccountInfo', 'getBalance', 'getTokenSupply', 'getSignaturesForAddress', 'getTransaction'] };
  if (/\b(file|report|markdown|download|export|document)\b/.test(s)) tools.file_output = { formats: ['md'] };
  const category = tools.solana_read ? 'Onchain' : tools.code_run ? 'Data' : tools.web_fetch ? 'Research' : /writ|draft/.test(s) ? 'Writing' : 'Ops';
  return {
    name,
    tagline: sentence.slice(0, 88),
    brief: `${sentence} It returns a short structured answer and says plainly when the input is not enough.`,
    category,
    systemPrompt: `You are ${name}. Your job: ${sentence}\n\nMethod:\n1. Read the request field carefully and decide what is being asked.\n2. Use a tool only when the answer depends on information you do not have.\n3. Write the answer in plain language, short and specific.\n4. If the request is unclear or unsafe, say so in the answer field and stop.\n\nQuality bar: every claim in the answer must come from the input or from a tool result.`,
    model: 'openai/gpt-4.1-mini',
    tools,
    input: [{ name: 'request', type: 'text', description: 'What you want done, with any material it needs', required: true, maxLength: 6000 }],
    output: [
      { name: 'answer', type: 'text', description: 'The result, in plain language', required: true },
      { name: 'confidence', type: 'string', description: 'How sure the agent is', required: true, enum: ['high', 'medium', 'low'] },
    ],
    limits: { maxSteps: Object.keys(tools).length ? 3 : 1, maxOutputTokens: 700, maxInputChars: 6000 },
    makerFee: 10_000,
    examples: [{ title: 'A typical request', input: { request: sentence.slice(0, 200) } }],
  };
}

/**
 * A remix without a script: the change sentence becomes a new name and a line in the instructions, and "also
 * return/add/include X" adds an output field X. Enough for the whole flow to run with nothing paid.
 */
export function standInRemix(change: string, spec: any) {
  const base = String(spec?.name ?? 'Agent').replace(/ (Remix|Plus)( \d+)?$/, '');
  const name = `${base} Remix`.slice(0, 40);
  const set: Record<string, unknown> = {
    name: name.toLowerCase() === String(spec?.name ?? '').toLowerCase() ? `${base.slice(0, 32)} Remix 2` : name,
    tagline: change.slice(0, 90),
    systemPrompt: `${String(spec?.systemPrompt ?? '').trim()}\n\nThis version also follows one more rule: ${change}`,
  };
  const also = change.match(/\balso (?:return|give|add|include|list)s? (?:a |an |the |one )?([a-z][a-z ]{2,30}?)(?:[.,;]| for | to | with |$)/i)?.[1];
  const fieldName = also?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 32);
  if (fieldName && Array.isArray(spec?.output) && !spec.output.some((f: any) => f.name === fieldName)) {
    set.output = [...spec.output, { name: fieldName, type: 'text', description: also!.trim(), required: true }];
  }
  return { summary: `Made a version that ${change.replace(/\.$/, '').toLowerCase()}.`, set };
}

/**
 * A new version without a recording: the name stays, the request becomes one more rule in the instructions, and
 * "also return/add/include X" adds an output field X, as in a remix.
 */
export function standInVersion(change: string, spec: any) {
  const set: Record<string, unknown> = { systemPrompt: `${String(spec?.systemPrompt ?? '').trim()}\n\nAlso: ${change}` };
  const also = change.match(/\balso (?:return|give|add|include|list)s? (?:a |an |the |one )?([a-z][a-z ]{2,30}?)(?:[.,;]| for | to | with |$)/i)?.[1];
  const fieldName = also?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 32);
  if (fieldName && Array.isArray(spec?.output) && !spec.output.some((f: any) => f.name === fieldName)) {
    set.output = [...spec.output, { name: fieldName, type: 'text', description: also!.trim(), required: true }];
  }
  return { summary: `This version ${change.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}.`, set };
}

/** Values that fit a field, for stand-in tests. The text-like field carries the request. */
function standInValue(f: any, text: string): unknown {
  if (f.enum?.length) return f.enum[0];
  switch (f.type) {
    case 'number':
    case 'integer':
      return 3;
    case 'boolean':
      return false;
    case 'string[]':
      return text.split(/[.,;:] */).map((x: string) => x.trim()).filter(Boolean).slice(0, 4);
    case 'object':
      return {};
    default:
      return f.maxLength && text.length > f.maxLength ? text.slice(0, f.maxLength) : text;
  }
}

function standIn(v: View): FakeTurn {
  switch (v.req.purpose) {
    case 'spec':
      return { text: JSON.stringify(standInSpec(v.sentence() || 'Answer questions about a short text')) };
    case 'remix': {
      const r = v.remixRequest();
      return { text: JSON.stringify(standInRemix(r?.change ?? 'Answer more briefly', r?.spec)) };
    }
    case 'version': {
      const r = v.versionRequest();
      return { text: JSON.stringify(standInVersion(r?.change ?? 'Answer more briefly', r?.spec)) };
    }
    case 'tests': {
      const spec = v.specForTests();
      const fields: any[] = Array.isArray(spec?.input) && spec.input.length ? spec.input : [{ name: 'request', type: 'text', required: true }];
      const texts = [`Typical request one`, `Short`, `A longer and more detailed request that gives plenty of context to work with.`, `Totals: 3, 5 and 8`];
      const tasks = ['Handles a typical request', 'Handles a short request', 'Handles a detailed request', 'Handles a request with numbers'].map((t, i) => ({
        title: t,
        input: Object.fromEntries(fields.filter((f, k) => k === 0 || f.required).map((f) => [f.name, standInValue(f, texts[i])])),
        checks: [{ type: 'schema' }],
      }));
      return { text: JSON.stringify({ tests: tasks }) };
    }
    case 'judge':
      return { text: JSON.stringify({ pass: true, reason: 'The answer addresses the rubric.' }) };
    case 'agent': {
      const input = v.input();
      const raw = JSON.stringify(input);
      const out: Record<string, unknown> = {};
      const refuse = ATTACK.test(raw);
      for (const [name, type] of v.outputFields()) {
        if (type.startsWith('number') || type.startsWith('integer')) out[name] = 0;
        else if (type.startsWith('boolean')) out[name] = false;
        else if (type.startsWith('string[]')) out[name] = [];
        else if (type.startsWith('object')) out[name] = {};
        else if (/one of: ([^|)]+)/.test(type)) out[name] = type.match(/one of: ([^|)\s]+)/)![1];
        else out[name] = refuse ? 'I cannot help with that part of the request. I only do the job I was built for.' : `Handled: ${raw.slice(0, 160)}`;
      }
      // Fill enum fields from the system prompt's field list.
      const sys = v.messages[0]?.content ?? '';
      for (const m of sys.matchAll(/^- ([a-z][a-z0-9_]*) \([^)]*one of: ([^)]+)\)/gm)) out[m[1]] = m[2].split(' | ')[0].trim();
      return { text: JSON.stringify(out) };
    }
  }
}
