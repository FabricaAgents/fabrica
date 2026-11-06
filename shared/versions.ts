// Versions and signed test reports, the parts both sides need: the limits, the report message that is signed, and
// the public summary of what a version changed. docs/VERSIONS.md explains every rule here.
import type { AgentSpec } from './types';
import { BEHAVIOUR_FIELDS, specChanges, type DiffLine, type RemixField } from './remix';

export const VERSION_LIMITS = {
  /** New versions an agent may publish in any 24 hours. Rollbacks are counted on their own. */
  perDay: 3,
  /** Rollbacks per agent in any 24 hours. */
  rollbacksPerDay: 5,
  /** Versions one agent can have in all. */
  maxVersions: 50,
  /** A version draft that is not published blocks a new one until it has been idle this long. */
  openDraftIdleMs: 24 * 3_600_000,
};

/** What kind of step made a version. */
export type VersionKind = 'build' | 'remix' | 'improve' | 'edit' | 'example' | 'earlier';

/** One part of the spec a version changed, as the public changelog shows it. */
export interface VersionChange {
  field: RemixField | 'makerFee';
  label: string;
  behaviour: boolean;
  added: number;
  removed: number;
  /** The lines themselves, only for parts every buyer can already see. The instructions stay private: counts only. */
  lines: DiffLine[] | null;
}

/** Parts of a spec a buyer never sees, so the public changelog shows only how much changed. */
const PRIVATE_FIELDS = new Set(['systemPrompt']);

export function versionChanges(before: AgentSpec, after: AgentSpec): VersionChange[] {
  return specChanges(before, after).map((c) => ({
    field: c.field,
    label: c.label,
    behaviour: c.behaviour,
    added: c.lines.filter((l) => l.op === 'add').length,
    removed: c.lines.filter((l) => l.op === 'del').length,
    lines: PRIVATE_FIELDS.has(c.field) ? null : c.lines.filter((l) => l.op !== 'same').slice(0, 24),
  }));
}

/** One short line per changed part: "Instructions: 2 lines added, 1 removed". */
export function changeLine(c: Pick<VersionChange, 'label' | 'added' | 'removed'>): string {
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
  if (c.added && c.removed) return `${c.label}: ${n(c.added, 'line')} added, ${c.removed} removed`;
  if (c.added) return `${c.label}: ${n(c.added, 'line')} added`;
  if (c.removed) return `${c.label}: ${n(c.removed, 'line')} removed`;
  return `${c.label}: changed`;
}

export const changesBehaviourOf = (cs: VersionChange[]) => cs.some((c) => (BEHAVIOUR_FIELDS as readonly string[]).includes(c.field));

// ---------------------------------------------------------------- signed test reports

/** The fields of a test report, in the order they are signed. */
export interface TestReportBody {
  agent: string;
  version: number;
  /** SHA-256 of the version's spec exactly as it was tested. The maker can check it; buyers see the public parts. */
  specHash: string;
  runId: string;
  model: string;
  total: number;
  passed: number;
  safetyTotal: number;
  safetyPassed: number;
  taskTotal: number;
  taskPassed: number;
  score: number;
  publishable: boolean;
  /** SHA-256 of JSON.stringify(results), the results /api/agents/<slug>/versions/<n>/report returns. */
  resultsHash: string;
  testedAt: number;
  signedAt: number;
}

export interface TestReport extends TestReportBody {
  format: 'fabrica-test-report:v1';
  /** ed25519 signature of reportMessage(), base58, by the key at /api/receipts/key. */
  signature: string;
}

export const TEST_REPORT_FORMAT = 'fabrica-test-report:v1|agent|version|specHash|runId|model|total|passed|safetyTotal|safetyPassed|taskTotal|taskPassed|score|publishable|resultsHash|testedAt|signedAt';

export function reportMessage(r: TestReportBody): string {
  return ['fabrica-test-report:v1', r.agent, r.version, r.specHash, r.runId, r.model, r.total, r.passed, r.safetyTotal, r.safetyPassed, r.taskTotal, r.taskPassed, r.score, r.publishable ? 1 : 0, r.resultsHash, r.testedAt, r.signedAt].join('|');
}
