// Remix rules both sides need: the royalty share, which parts of a spec a remix may change, and the before and
// after a maker reviews. docs/REMIX.md explains every rule here.
import type { AgentSpec, FieldSpec, ToolConfig } from './types';

/** The original's maker gets this share of the remix maker's part of every paid call. */
export const REMIX_ROYALTY_BPS = 2000;

/** The royalty out of a maker part, rounded down to the micro-USDC so the maker part never goes negative. */
export function royaltyOf(makerFee: number, bps: number): number {
  if (!(bps > 0) || !(makerFee > 0)) return 0;
  return Math.floor((makerFee * Math.min(bps, 10_000)) / 10_000);
}

/** The parts of a spec the remix model may rewrite. Price, slug and anything about money are not among them. */
export const REMIX_FIELDS = ['name', 'tagline', 'brief', 'category', 'systemPrompt', 'model', 'tools', 'input', 'output', 'limits', 'examples'] as const;
export type RemixField = (typeof REMIX_FIELDS)[number];

/** The parts that change what an agent does. A remix has to change at least one of them. */
export const BEHAVIOUR_FIELDS = ['systemPrompt', 'model', 'tools', 'input', 'output', 'limits'] as const;

export const FIELD_LABEL: Record<RemixField | 'makerFee', string> = {
  name: 'Name',
  tagline: 'Tagline',
  brief: 'Brief',
  category: 'Category',
  systemPrompt: 'Instructions',
  model: 'Model',
  tools: 'Tools',
  input: 'Input',
  output: 'Output',
  limits: 'Limits',
  examples: 'Examples',
  makerFee: 'Earnings per call',
};

export interface DiffLine {
  op: 'same' | 'add' | 'del';
  text: string;
}

/** Line by line difference (longest common subsequence). Inputs are capped, specs are short. */
export function lineDiff(before: string[], after: string[]): DiffLine[] {
  const a = before.slice(0, 400);
  const b = after.slice(0, 400);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: 'del', text: a[i++] });
    else out.push({ op: 'add', text: b[j++] });
  }
  while (i < n) out.push({ op: 'del', text: a[i++] });
  while (j < m) out.push({ op: 'add', text: b[j++] });
  return out;
}

const fieldLine = (f: FieldSpec) => `${f.name}: ${f.type}${f.required ? '' : ', optional'}${f.enum?.length ? ` (${f.enum.join(' | ')})` : ''}`;

function toolLines(t: ToolConfig): string[] {
  const out: string[] = [];
  if (t.web_fetch) out.push(`web reads${t.web_fetch.allowDomains.length ? `: ${t.web_fetch.allowDomains.join(', ')}` : ', any public site'}`);
  if (t.code_run) out.push(`code runner${t.code_run.network ? `, network: ${t.code_run.allowDomains.join(', ')}` : ', no network'}`);
  if (t.solana_read) out.push(`Solana reads: ${t.solana_read.methods.join(', ')}`);
  if (t.file_output) out.push(`files: ${t.file_output.formats.join(', ')}`);
  return out.length ? out : ['no tools'];
}

/** A spec part as lines a person can compare. */
export function fieldText(spec: AgentSpec, field: RemixField | 'makerFee'): string[] {
  switch (field) {
    case 'systemPrompt':
      return spec.systemPrompt.split('\n');
    case 'tools':
      return toolLines(spec.tools);
    case 'input':
    case 'output':
      return spec[field].map(fieldLine);
    case 'limits':
      return [`${spec.limits.maxSteps} steps, answers up to ${spec.limits.maxOutputTokens} tokens, input up to ${spec.limits.maxInputChars} characters`];
    case 'examples':
      return spec.examples.map((e) => e.title);
    case 'makerFee':
      return [`${spec.makerFee / 1e6} USDC`];
    default:
      return [String(spec[field])];
  }
}

export interface SpecChange {
  field: RemixField | 'makerFee';
  label: string;
  lines: DiffLine[];
  behaviour: boolean;
}

/** Every part that differs between the original and the remix, in the order a maker reads a spec. */
export function specChanges(before: AgentSpec, after: AgentSpec): SpecChange[] {
  const out: SpecChange[] = [];
  for (const field of [...REMIX_FIELDS, 'makerFee'] as const) {
    const a = fieldText(before, field);
    const b = fieldText(after, field);
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    out.push({ field, label: FIELD_LABEL[field], lines: lineDiff(a, b), behaviour: (BEHAVIOUR_FIELDS as readonly string[]).includes(field) });
  }
  return out;
}

/** True when the remix changes what the agent does, not only how it is described. */
export function changesBehaviour(before: AgentSpec, after: AgentSpec): boolean {
  return BEHAVIOUR_FIELDS.some((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
}
