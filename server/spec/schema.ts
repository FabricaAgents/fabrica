// An agent spec arrives from a model or from a maker's edits. Either way it is untrusted: this file decides what
// a valid spec is, fills safe defaults and refuses the rest with a reason a person can act on.
import { CATEGORIES, TOOL_NAMES, type AgentSpec, type FieldSpec, type FieldType, type FileFormat, type ToolConfig } from '../../shared/types';
import { DEFAULT_MODEL, modelById } from '../../shared/models';
import { NETWORK_LIMITS } from '../../shared/networks';

export const SOLANA_METHODS = [
  'getBalance',
  'getAccountInfo',
  'getTokenSupply',
  'getTokenLargestAccounts',
  'getTokenAccountsByOwner',
  'getSignaturesForAddress',
  'getTransaction',
  'pumpCurve',
] as const;

const FIELD_TYPES: FieldType[] = ['string', 'text', 'number', 'integer', 'boolean', 'string[]', 'object'];
const FORMATS: FileFormat[] = ['md', 'csv', 'json', 'txt'];
const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const DOMAIN_RE = /^(?=.{3,253}$)(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

export const LIMITS = {
  makerFeeMin: 1_000,
  makerFeeMax: 5_000_000,
  maxSteps: 8,
  maxOutputTokens: 4000,
  maxInputChars: 16_000,
};

export class SpecError extends Error {
  constructor(public problems: string[]) {
    super(problems.join('; '));
    this.name = 'SpecError';
  }
}

const s = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : '');
const clampInt = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'agent'
  );
}

function fields(raw: unknown, label: string, min: number, max: number, problems: string[]): FieldSpec[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: FieldSpec[] = [];
  const seen = new Set<string>();
  for (const f of list.slice(0, max)) {
    const name = s(f?.name, 32).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!NAME_RE.test(name)) {
      problems.push(`${label} field "${s(f?.name, 32)}" needs a name of letters, digits and _`);
      continue;
    }
    if (seen.has(name)) {
      problems.push(`${label} field "${name}" appears twice`);
      continue;
    }
    seen.add(name);
    const type = (FIELD_TYPES as string[]).includes(f?.type) ? (f.type as FieldType) : 'string';
    const field: FieldSpec = {
      name,
      type,
      description: s(f?.description, 200) || name.replace(/_/g, ' '),
      required: f?.required !== false,
    };
    if (Array.isArray(f?.enum) && f.enum.length) field.enum = f.enum.slice(0, 20).map((e: unknown) => s(e, 60)).filter(Boolean);
    if (type === 'string' || type === 'text') field.maxLength = clampInt(f?.maxLength, 1, LIMITS.maxInputChars, type === 'text' ? 8000 : 400);
    out.push(field);
  }
  if (out.length < min) problems.push(`${label} needs at least ${min} field${min > 1 ? 's' : ''}`);
  return out;
}

function domains(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.map((d) => s(d, 253).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter((d) => DOMAIN_RE.test(d)))].slice(0, 20);
}

function tools(raw: any, problems: string[]): ToolConfig {
  const t: ToolConfig = {};
  if (!raw || typeof raw !== 'object') return t;
  for (const k of Object.keys(raw)) if (!(TOOL_NAMES as readonly string[]).includes(k)) problems.push(`unknown tool "${k}"`);
  if (raw.web_fetch) t.web_fetch = { allowDomains: domains(raw.web_fetch.allowDomains) };
  if (raw.code_run) {
    const network = raw.code_run.network === true;
    const allow = domains(raw.code_run.allowDomains);
    if (network && !allow.length) problems.push('the code runner can only reach the network for named domains');
    t.code_run = { network: network && allow.length > 0, allowDomains: allow, timeMs: clampInt(raw.code_run.timeMs, 200, 5000, 2000), memoryMb: clampInt(raw.code_run.memoryMb, 8, 64, 32) };
  }
  if (raw.solana_read) {
    const req = Array.isArray(raw.solana_read.methods) ? raw.solana_read.methods : SOLANA_METHODS;
    const methods = req.filter((m: string) => (SOLANA_METHODS as readonly string[]).includes(m));
    t.solana_read = { methods: methods.length ? methods : [...SOLANA_METHODS] };
  }
  if (raw.file_output) {
    const f = (Array.isArray(raw.file_output.formats) ? raw.file_output.formats : ['md']).filter((x: string) => (FORMATS as string[]).includes(x));
    t.file_output = { formats: f.length ? f : ['md'] };
  }
  if (raw.hire_agent) {
    // The hire list: which agents, how often, and the most the hires may cost per run. Whether each one exists and may
    // be hired is checked against the live agents when the spec is saved and at publish (server/networks.ts).
    const list = Array.isArray(raw.hire_agent.agents) ? raw.hire_agent.agents : [];
    const agents: { slug: string; calls: number }[] = [];
    for (const a of list) {
      const slug = s(typeof a === 'string' ? a : a?.slug, 60).toLowerCase();
      if (!SLUG_RE.test(slug)) {
        problems.push(`"${slug || 'an empty name'}" is not an agent's slug`);
        continue;
      }
      if (agents.some((x) => x.slug === slug)) continue;
      agents.push({ slug, calls: clampInt(typeof a === 'string' ? 1 : a?.calls, 1, NETWORK_LIMITS.callsPerHire, 1) });
    }
    if (!agents.length) problems.push('hiring needs at least one agent to hire');
    if (agents.length > NETWORK_LIMITS.hiresPerAgent) problems.push(`an agent can hire at most ${NETWORK_LIMITS.hiresPerAgent} other agents`);
    const budget = Math.round(Number(raw.hire_agent.budget));
    if (!Number.isFinite(budget) || budget < NETWORK_LIMITS.budgetMin || budget > NETWORK_LIMITS.budgetMax) problems.push(`the hire budget must be between ${NETWORK_LIMITS.budgetMin / 1e6} and ${NETWORK_LIMITS.budgetMax / 1e6} USDC per run`);
    t.hire_agent = { agents: agents.slice(0, NETWORK_LIMITS.hiresPerAgent), budget: Math.min(NETWORK_LIMITS.budgetMax, Math.max(NETWORK_LIMITS.budgetMin, Number.isFinite(budget) ? budget : 0)) };
  }
  return t;
}

/** Turns anything into a valid spec or throws a SpecError that lists every problem. */
export function normalizeSpec(raw: any): AgentSpec {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object') throw new SpecError(['the spec is not an object']);
  const name = s(raw.name, 40);
  if (name.length < 3) problems.push('the name needs at least 3 characters');
  const brief = s(raw.brief, 600);
  if (brief.length < 20) problems.push('the brief needs at least 20 characters');
  const systemPrompt = s(raw.systemPrompt, 6000);
  if (systemPrompt.length < 40) problems.push('the system prompt needs at least 40 characters');
  const model = modelById(String(raw.model ?? '')) ? String(raw.model) : DEFAULT_MODEL;
  const category = (CATEGORIES as readonly string[]).includes(raw.category) ? raw.category : 'Research';
  const input = fields(raw.input, 'input', 1, 8, problems);
  const output = fields(raw.output, 'output', 1, 12, problems);
  const t = tools(raw.tools, problems);
  const makerFee = clampInt(raw.makerFee, LIMITS.makerFeeMin, LIMITS.makerFeeMax, 10_000);
  const limits = {
    maxSteps: clampInt(raw.limits?.maxSteps, 1, LIMITS.maxSteps, Object.keys(t).length ? 4 : 1),
    maxOutputTokens: clampInt(raw.limits?.maxOutputTokens, 200, LIMITS.maxOutputTokens, 900),
    maxInputChars: clampInt(raw.limits?.maxInputChars, 100, LIMITS.maxInputChars, 6000),
  };
  if (!Object.keys(t).length) limits.maxSteps = Math.min(limits.maxSteps, 2);
  else limits.maxSteps = Math.max(limits.maxSteps, 2);
  const examples = (Array.isArray(raw.examples) ? raw.examples : [])
    .slice(0, 3)
    .map((e: any) => ({ title: s(e?.title, 80) || 'Example', input: e?.input && typeof e.input === 'object' ? e.input : {} }))
    .filter((e: { input: Record<string, unknown> }) => validateInput(input, e.input).length === 0);
  if (problems.length) throw new SpecError(problems);
  return {
    name,
    slug: slugify(s(raw.slug, 40) || name),
    tagline: s(raw.tagline, 90) || brief.slice(0, 90),
    brief,
    category,
    systemPrompt,
    model,
    tools: t,
    input,
    output,
    limits,
    makerFee,
    examples,
  };
}

function checkValue(f: FieldSpec, v: unknown): string | null {
  if (v === undefined || v === null || v === '') return f.required ? `${f.name} is required` : null;
  switch (f.type) {
    case 'string':
    case 'text':
      if (typeof v !== 'string') return `${f.name} must be text`;
      if (f.maxLength && v.length > f.maxLength) return `${f.name} is longer than ${f.maxLength} characters`;
      if (f.enum?.length && !f.enum.includes(v)) return `${f.name} must be one of ${f.enum.join(', ')}`;
      return null;
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? null : `${f.name} must be a number`;
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v) ? null : `${f.name} must be a whole number`;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${f.name} must be true or false`;
    case 'string[]':
      return Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : `${f.name} must be a list of text`;
    case 'object':
      return typeof v === 'object' && !Array.isArray(v) ? null : `${f.name} must be an object`;
  }
}

export function validateInput(spec: FieldSpec[], value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['the input must be a JSON object'];
  const v = value as Record<string, unknown>;
  const errs: string[] = [];
  for (const f of spec) {
    const e = checkValue(f, v[f.name]);
    if (e) errs.push(e);
  }
  for (const k of Object.keys(v)) if (!spec.some((f) => f.name === k)) errs.push(`unknown field ${k}`);
  return errs;
}

export function validateOutput(spec: FieldSpec[], value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['the output is not a JSON object'];
  const v = value as Record<string, unknown>;
  const errs: string[] = [];
  for (const f of spec) {
    const field = { ...f, maxLength: undefined, enum: f.enum };
    const e = checkValue(field, v[f.name]);
    if (e) errs.push(e);
  }
  return errs;
}

/** The output contract as JSON Schema, for the 402 response and the MCP tool list. */
export function toJsonSchema(list: FieldSpec[]): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const f of list) {
    const base: Record<string, unknown> = { description: f.description };
    if (f.type === 'string' || f.type === 'text') Object.assign(base, { type: 'string' }, f.maxLength ? { maxLength: f.maxLength } : {}, f.enum ? { enum: f.enum } : {});
    else if (f.type === 'string[]') Object.assign(base, { type: 'array', items: { type: 'string' } });
    else Object.assign(base, { type: f.type });
    props[f.name] = base;
  }
  return { type: 'object', properties: props, required: list.filter((f) => f.required).map((f) => f.name), additionalProperties: false };
}

export function inputChars(value: Record<string, unknown>): number {
  return JSON.stringify(value).length;
}
