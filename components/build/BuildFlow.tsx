'use client';
// The build flow: describe, pay for one build round, review and edit the spec, write and run the tests, publish.
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentSpec, FieldSpec, FieldType, PaymentRequirements, PriceBreakdown, TestCase, TestResult, TestRunSummary } from '../../shared/types';
import { CATEGORIES } from '../../shared/types';
import { MODELS } from '../../shared/models';
import { shortAddr, usd } from '../../shared/format';
import { api, ApiError } from '../../lib/api';
import { payRequirements, PayError } from '../../lib/pay';
import { currentWallet, loadSession, signIn, signOut, useWallet } from '../../lib/wallet';
import { IconArrow, IconCheck, IconCross, IconWallet, ToolIcon, TOOL_LABEL } from '../Icons';
import { RemixDiff } from './RemixDiff';
import { REMIX_ROYALTY_BPS, royaltyOf } from '../../shared/remix';

interface Draft {
  id: string;
  sentence: string;
  status: 'spec_pending' | 'spec' | 'tests_pending' | 'tests' | 'running' | 'tested' | 'published' | 'failed';
  spec: AgentSpec | null;
  tests: TestCase[];
  aiSpent: number;
  aiBudget: number;
  runsUsed: number;
  run: (TestRunSummary & { results: TestResult[]; progress: { done: number; total: number } | null }) | null;
  specHashTested: boolean;
  agentSlug: string | null;
  error: string | null;
  price: PriceBreakdown | null;
  buildFee: number;
  remix: { parent: { slug: string; name: string; maker: string | null; example: boolean }; before: AgentSpec; summary: string | null; royaltyBps: number; feeFloor: number } | null;
  improve: { agent: { slug: string; name: string }; before: AgentSpec; summary: string | null; fromVersion: number; nextVersion: number; feeFloor: number } | null;
}

/** The live agent a new version starts from, as the improve page passes it in. */
export interface ImproveStart {
  slug: string;
  name: string;
  tagline: string;
  maker: string;
  version: number;
  next: number;
  price: PriceBreakdown;
  tests: { taskPassed: number; taskTotal: number; safetyPassed: number; safetyTotal: number } | null;
  paidCalls: number;
}

/** The agent a remix starts from, as the remix page passes it in. */
export interface RemixStart {
  slug: string;
  name: string;
  tagline: string;
  maker: string | null;
  example: boolean;
  makerFee: number;
  price: PriceBreakdown;
  tests: { passed: number; total: number } | null;
}

interface Me {
  wallet: string | null;
  tier?: { name: string; liveAgents: number };
  agents?: { slug: string; name: string; status: string; tests: TestRunSummary | null; stats: { paidCalls: number } }[];
  drafts?: { id: string; sentence: string; status: string; name: string | null; updatedAt: number }[];
}

const IDEAS = [
  'Reads a public changelog page and lists every breaking change with the version it came in',
  'Takes a Solana wallet address and summarises its last 20 transactions in plain words',
  'Turns a messy list of tasks into a prioritised plan with time estimates as a Markdown file',
  'Checks a JSON document against a schema I paste and explains every error',
];

const REMIX_IDEAS = ['Answer in Spanish as well as English', 'Keep every answer under 60 words', 'Also return a one-line summary at the top'];
const IMPROVE_IDEAS = ['Also return a confidence note for every answer', 'Keep every answer under 80 words', 'Say plainly when the input is missing something'];

const FIELD_TYPES: FieldType[] = ['string', 'text', 'number', 'integer', 'boolean', 'string[]', 'object'];
const RUNS_PER_ROUND = 3;

async function payAndPost(path: string, body: unknown, payer: string): Promise<any> {
  const q = await api<{ accepts: PaymentRequirements[] }>(path, { body });
  if (q.status !== 402) return q.body;
  const header = await payRequirements(q.body.accepts[0], payer);
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment': header }, body: JSON.stringify(body) });
  const b = await r.json();
  if (!r.ok) throw new ApiError(r.status, b.error, b.message ?? 'The request failed.', b);
  return b;
}

function Steps({ status, remix, improve }: { status: Draft['status'] | 'describe'; remix?: boolean; improve?: boolean }) {
  const order = ['describe', 'spec', 'tests', 'publish'];
  const at = status === 'describe' ? 0 : status === 'spec_pending' || status === 'spec' || status === 'failed' ? 1 : status === 'tests_pending' || status === 'tests' || status === 'running' ? 2 : 3;
  return (
    <ol className="steps">
      {[improve ? 'Improve' : remix ? 'Change' : 'Describe', 'Spec', 'Tests', 'Publish'].map((s, i) => (
        <li key={s} className={i < at ? 'is-done' : i === at ? 'is-now' : ''}>
          <span>{i < at ? <IconCheck /> : `0${i + 1}`}</span>
          {s}
          {order[i] === 'publish' && status === 'published' ? '' : ''}
        </li>
      ))}
    </ol>
  );
}

function Working({ title, note }: { title: string; note: string }) {
  return (
    <div className="working panel">
      <div className="working__belt" aria-hidden="true">
        <span />
      </div>
      <h2 className="h3">{title}</h2>
      <p className="muted">{note}</p>
    </div>
  );
}

// ------------------------------------------------------------------ spec editor

function FieldsEditor({ label, fields, onChange }: { label: string; fields: FieldSpec[]; onChange: (f: FieldSpec[]) => void }) {
  const up = (i: number, p: Partial<FieldSpec>) => onChange(fields.map((f, k) => (k === i ? { ...f, ...p } : f)));
  return (
    <div className="fields-ed">
      <div className="fields-ed__head">
        <span className="label">{label}</span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange([...fields, { name: `field_${fields.length + 1}`, type: 'string', description: '', required: true }])}>
          Add field
        </button>
      </div>
      {fields.map((f, i) => (
        <div className="fields-ed__row" key={i}>
          <input className="input input--mono" aria-label="Field name" value={f.name} onChange={(e) => up(i, { name: e.target.value })} />
          <select className="select" aria-label="Type" value={f.type} onChange={(e) => up(i, { type: e.target.value as FieldType })}>
            {FIELD_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <input className="input" aria-label="Description" placeholder="What it is" value={f.description} onChange={(e) => up(i, { description: e.target.value })} />
          <label className="check">
            <input type="checkbox" checked={f.required} onChange={(e) => up(i, { required: e.target.checked })} /> required
          </label>
          <button type="button" className="icon-btn" aria-label="Remove field" onClick={() => onChange(fields.filter((_, k) => k !== i))}>
            <IconCross />
          </button>
        </div>
      ))}
    </div>
  );
}

function SpecEditor({ spec, price, onSave, busy }: { spec: AgentSpec; price: PriceBreakdown | null; onSave: (s: AgentSpec) => void; busy: boolean }) {
  const [s, setS] = useState<AgentSpec>(spec);
  useEffect(() => setS(spec), [spec]);
  const set = (p: Partial<AgentSpec>) => setS((x) => ({ ...x, ...p }));
  const tools = s.tools;
  const toggle = (name: keyof AgentSpec['tools'], on: boolean) => {
    const next = { ...tools };
    if (!on) delete next[name];
    else if (name === 'web_fetch') next.web_fetch = { allowDomains: [] };
    else if (name === 'code_run') next.code_run = { network: false, allowDomains: [], timeMs: 2000, memoryMb: 32 };
    else if (name === 'solana_read') next.solana_read = { methods: ['getAccountInfo', 'getBalance', 'getTokenSupply', 'getSignaturesForAddress', 'getTransaction'] };
    else next.file_output = { formats: ['md'] };
    set({ tools: next });
  };
  const dirty = JSON.stringify(s) !== JSON.stringify(spec);
  return (
    <div className="spec">
      <div className="spec__grid">
        <div className="field">
          <label className="label" htmlFor="sp-name">
            Name
          </label>
          <input id="sp-name" className="input" maxLength={40} value={s.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="field">
          <label className="label" htmlFor="sp-cat">
            Category
          </label>
          <select id="sp-cat" className="select" value={s.category} onChange={(e) => set({ category: e.target.value as AgentSpec['category'] })}>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="field spec__wide">
          <label className="label" htmlFor="sp-tag">
            Tagline
          </label>
          <input id="sp-tag" className="input" maxLength={90} value={s.tagline} onChange={(e) => set({ tagline: e.target.value })} />
        </div>
        <div className="field spec__wide">
          <label className="label" htmlFor="sp-brief">
            Brief for buyers
          </label>
          <textarea id="sp-brief" className="textarea" rows={3} maxLength={600} value={s.brief} onChange={(e) => set({ brief: e.target.value })} />
        </div>
        <div className="field spec__wide">
          <label className="label" htmlFor="sp-prompt">
            System prompt (private to you)
          </label>
          <textarea id="sp-prompt" className="textarea textarea--mono" rows={10} maxLength={6000} value={s.systemPrompt} onChange={(e) => set({ systemPrompt: e.target.value })} />
        </div>
      </div>

      <div className="spec__section">
        <span className="label">Model</span>
        <div className="models">
          {MODELS.map((m) => (
            <label key={m.id} className={`model ${s.model === m.id ? 'is-on' : ''}`}>
              <input type="radio" name="model" checked={s.model === m.id} onChange={() => set({ model: m.id })} />
              <b>{m.label}</b>
              <span>{m.note}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="spec__section">
        <span className="label">Tools</span>
        <div className="tools-ed">
          {(['web_fetch', 'code_run', 'solana_read', 'file_output'] as const).map((t) => (
            <div key={t} className={`tool-ed ${tools[t] ? 'is-on' : ''}`}>
              <label className="tool-ed__head">
                <input type="checkbox" checked={Boolean(tools[t])} onChange={(e) => toggle(t, e.target.checked)} />
                <ToolIcon tool={t} />
                <b>{TOOL_LABEL[t]}</b>
              </label>
              {t === 'web_fetch' && tools.web_fetch ? (
                <input className="input input--mono" placeholder="Allowed sites, comma separated; empty means any public site" value={tools.web_fetch.allowDomains.join(', ')} onChange={(e) => set({ tools: { ...tools, web_fetch: { allowDomains: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } } })} />
              ) : null}
              {t === 'code_run' && tools.code_run ? (
                <div className="row">
                  <label className="check">
                    <input type="checkbox" checked={tools.code_run.network} onChange={(e) => set({ tools: { ...tools, code_run: { ...tools.code_run!, network: e.target.checked } } })} /> network
                  </label>
                  {tools.code_run.network ? (
                    <input className="input input--mono" placeholder="Domains code may read" value={tools.code_run.allowDomains.join(', ')} onChange={(e) => set({ tools: { ...tools, code_run: { ...tools.code_run!, allowDomains: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } } })} />
                  ) : (
                    <span className="hint">No network, no files, {tools.code_run.timeMs} ms, {tools.code_run.memoryMb} MB</span>
                  )}
                </div>
              ) : null}
              {t === 'solana_read' && tools.solana_read ? <span className="hint">{tools.solana_read.methods.join(', ')}</span> : null}
              {t === 'file_output' && tools.file_output ? <span className="hint">Formats: {tools.file_output.formats.join(', ')}</span> : null}
            </div>
          ))}
        </div>
      </div>

      <div className="spec__section">
        <FieldsEditor label="Input" fields={s.input} onChange={(input) => set({ input })} />
        <FieldsEditor label="Output" fields={s.output} onChange={(output) => set({ output })} />
      </div>

      <div className="spec__section spec__grid">
        <div className="field">
          <label className="label" htmlFor="sp-fee">
            Your earnings per call, USDC
          </label>
          <input id="sp-fee" className="input" inputMode="decimal" value={s.makerFee / 1e6} onChange={(e) => set({ makerFee: Math.round(Number(e.target.value) * 1e6) || 0 })} />
        </div>
        <div className="field">
          <label className="label" htmlFor="sp-steps">
            Steps per call
          </label>
          <input id="sp-steps" className="input" type="number" min={1} max={8} value={s.limits.maxSteps} onChange={(e) => set({ limits: { ...s.limits, maxSteps: Number(e.target.value) } })} />
        </div>
        <div className="field">
          <label className="label" htmlFor="sp-out">
            Answer length, tokens
          </label>
          <input id="sp-out" className="input" type="number" min={200} max={4000} step={100} value={s.limits.maxOutputTokens} onChange={(e) => set({ limits: { ...s.limits, maxOutputTokens: Number(e.target.value) } })} />
        </div>
      </div>

      <div className="spec__foot">
        {price ? (
          <span className="spec__price">
            Buyers pay <b>{usd(price.total)}</b> per call: {usd(price.maker)} to you, {price.royalty ? `${usd(price.royalty)} royalty to the original maker, ` : ''}up to {usd(price.ai)} for AI, {usd(price.platform)} platform fee.
          </span>
        ) : (
          <span />
        )}
        <button className="btn btn--primary" type="button" disabled={busy || !dirty} onClick={() => onSave(s)}>
          {dirty ? 'Save changes' : 'Saved'}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ tests

function TestsPanel({ draft, busy, onRun, onEdit }: { draft: Draft; busy: boolean; onRun: () => void; onEdit: (b: unknown) => void }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [input, setInput] = useState('');
  const [must, setMust] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const runsLeft = RUNS_PER_ROUND - draft.runsUsed;
  const results = new Map((draft.run?.results ?? []).map((r) => [r.id, r]));
  const running = draft.status === 'running';
  const prog = draft.run?.progress;
  return (
    <div className="tests-ed">
      <div className="tests-ed__list">
        {draft.tests.map((t) => {
          const r = results.get(t.id);
          return (
            <div key={t.id} className={`tcase ${!t.enabled && !t.required ? 'is-off' : ''}`}>
              <span className={`ok-box ${r ? (r.pass ? '' : 'bad') : 'idle'}`}>{r ? r.pass ? <IconCheck /> : <IconCross /> : null}</span>
              <div className="tcase__body">
                <b>{t.title}</b>
                <span className={`tag-kind ${t.kind === 'task' || t.kind === 'robustness' ? '' : 'adv'}`}>{t.kind.replace('_', ' ')}</span>
                {r && !r.pass ? <span className="tcase__why">{r.error ?? r.checks.filter((c) => !c.pass).map((c) => c.detail).join('; ')}</span> : null}
              </div>
              {t.required ? (
                <span className="hint">always on</span>
              ) : (
                <label className="check">
                  <input type="checkbox" checked={t.enabled} disabled={running || busy} onChange={(e) => onEdit({ enabled: { [t.id]: e.target.checked } })} /> on
                </label>
              )}
            </div>
          );
        })}
      </div>
      {adding ? (
        <div className="panel panel__body add-test">
          <div className="field">
            <label className="label" htmlFor="at-title">
              Test title
            </label>
            <input id="at-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="at-input">
              Input as JSON
            </label>
            <textarea id="at-input" className="textarea textarea--mono" rows={4} value={input} placeholder={JSON.stringify(Object.fromEntries((draft.spec?.input ?? []).map((f) => [f.name, f.type === 'number' ? 1 : '...'])))} onChange={(e) => setInput(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="at-must">
              The answer must contain (comma separated)
            </label>
            <input id="at-must" className="input" value={must} onChange={(e) => setMust(e.target.value)} />
          </div>
          {err ? <span className="error-text">{err}</span> : null}
          <div className="row">
            <button
              className="btn btn--sm"
              type="button"
              onClick={() => {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(input);
                } catch {
                  return setErr('The input must be valid JSON.');
                }
                setErr(null);
                onEdit({ add: [{ title, input: parsed, mustContain: must.split(',').map((x) => x.trim()).filter(Boolean) }] });
                setAdding(false);
                setTitle('');
                setInput('');
                setMust('');
              }}
            >
              Add test
            </button>
            <button className="btn btn--ghost btn--sm" type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <div className="tests-ed__foot">
        {running ? (
          <div className="progress">
            <div className="progress__bar">
              <span style={{ width: `${prog ? Math.round((prog.done / Math.max(prog.total, 1)) * 100) : 4}%` }} />
            </div>
            <span className="hint">
              Running test {prog ? Math.min(prog.done + 1, prog.total) : 1} of {prog?.total ?? draft.tests.length}
            </span>
          </div>
        ) : (
          <>
            <button className="btn btn--ghost btn--sm" type="button" disabled={busy} onClick={() => setAdding(true)}>
              Add your own test
            </button>
            <button className="btn btn--primary" type="button" disabled={busy || runsLeft <= 0} onClick={onRun}>
              Run the tests <span className="muted-on">({runsLeft} of {RUNS_PER_ROUND} left)</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the flow

export function BuildFlow({ initialSentence, initialDraft, buildFee, buildOpen, closedReason, remix, improve }: { initialSentence: string; initialDraft: string | null; buildFee: number; buildOpen: boolean; closedReason: string | null; remix?: RemixStart; improve?: ImproveStart }) {
  const w = useWallet();
  const [sentence, setSentence] = useState(initialSentence);
  const [draftId, setDraftId] = useState<string | null>(initialDraft);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void loadSession();
  }, []);

  const loadMe = useCallback(async () => {
    try {
      setMe((await api<Me>('/api/me')).body);
    } catch {
      /* signed out */
    }
  }, []);

  useEffect(() => {
    if (w.session) void loadMe();
  }, [w.session, loadMe]);

  const loadDraft = useCallback(async (id: string) => {
    try {
      const { body } = await api<Draft>(`/api/drafts/${id}`);
      setDraft(body);
      const pending = body.status === 'spec_pending' || body.status === 'tests_pending' || body.status === 'running';
      if (timer.current) clearTimeout(timer.current);
      if (pending) timer.current = setTimeout(() => loadDraft(id), 1200);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setDraftId(null);
        setDraft(null);
      }
    }
  }, []);

  useEffect(() => {
    if (draftId && w.session) void loadDraft(draftId);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [draftId, w.session, loadDraft]);

  const go = (id: string | null) => {
    setDraftId(id);
    setDraft(null);
    const u = new URL(window.location.href);
    if (id) u.searchParams.set('draft', id);
    else u.searchParams.delete('draft');
    u.searchParams.delete('s');
    window.history.replaceState(null, '', u.toString());
  };

  const step = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof PayError ? e.message : `Something went wrong: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    step(async () => {
      if (!w.session) {
        const ok = await signIn();
        if (!ok) return;
      }
      try {
        const b = improve ? await payAndPost(`/api/agents/${improve.slug}/versions`, { sentence }, currentWallet()!) : await payAndPost('/api/build', remix ? { remixOf: remix.slug, sentence } : { sentence }, currentWallet()!);
        go(b.draftId);
      } catch (e) {
        // A version already in progress opens instead of a second one.
        if (e instanceof ApiError && e.body?.draftId) return go(String(e.body.draftId));
        throw e;
      }
      void loadMe();
    });
  const notMaker = Boolean(improve && w.session && w.session !== improve.maker);

  // ---------------------------------------------------------------- views

  if (!w.checked) return <div className="skeleton" style={{ height: 320 }} />;

  if (!draftId || !draft) {
    return (
      <div className="build-start">
        <Steps status="describe" remix={Boolean(remix)} improve={Boolean(improve)} />
        <div className="build-start__grid">
          <div className="panel describe">
            <label className="label" htmlFor="sentence">
              {improve ? `What should v${improve.next} of ${improve.name} do better? One sentence.` : remix ? `What should your version of ${remix.name} do differently? One sentence.` : 'Describe your agent in one sentence'}
            </label>
            <textarea id="sentence" className="describe__input" rows={3} maxLength={400} value={sentence} placeholder={improve ? 'Also...' : remix ? 'Make it...' : 'It reads...'} onChange={(e) => setSentence(e.target.value)} />
            <div className="describe__ideas">
              {(improve ? IMPROVE_IDEAS : remix ? REMIX_IDEAS : IDEAS).map((i) => (
                <button key={i} type="button" className="chip chip--btn" onClick={() => setSentence(i)}>
                  {i}
                </button>
              ))}
            </div>
            <div className="describe__foot">
              <span className="hint">{sentence.trim().length < 12 ? 'At least a dozen characters, at most 400.' : `${sentence.trim().length} of 400 characters`}</span>
              {notMaker ? (
                <span className="notice">
                  Only the maker of {improve!.name} can make its versions.{' '}
                  <Link className="link" href={`/remix/${improve!.slug}`}>
                    Remix it
                  </Link>{' '}
                  to make your own.
                </span>
              ) : buildOpen ? (
                <button className="btn btn--primary btn--lg" type="button" disabled={busy || sentence.trim().length < 12} onClick={start}>
                  {busy ? <span className="spinner" /> : <IconWallet />}
                  {w.session ? `Pay ${usd(buildFee)} and ${improve ? 'improve' : remix ? 'remix' : 'build'}` : `Sign in and ${improve ? 'improve' : remix ? 'remix' : 'build'}`}
                </button>
              ) : (
                <span className="notice">{closedReason}</span>
              )}
            </div>
            {error || w.error ? <div className="notice notice--fail">{error ?? w.error}</div> : null}
          </div>
          <aside className="build-aside">
            {remix ? <RemixOriginal remix={remix} wallet={w.session} /> : null}
            {improve ? <ImproveCurrent improve={improve} /> : null}
            <div className="panel panel__body">
              <span className="kicker kicker--plain">One build round, {usd(buildFee)}</span>
              {improve ? (
                <ul className="ticks">
                  <li>v{improve.next} of the spec, changed only where your sentence asks</li>
                  <li>The before and after, side by side, to edit</li>
                  <li>The full suite again: new task tests and every attack</li>
                  <li>Up to {RUNS_PER_ROUND} full test runs, then v{improve.next} goes live when it passes</li>
                </ul>
              ) : remix ? (
                <ul className="ticks">
                  <li>Your version of the spec, changed only where your sentence asks</li>
                  <li>The before and after, side by side, to edit</li>
                  <li>New task tests and every safety test, from scratch</li>
                  <li>Up to {RUNS_PER_ROUND} full test runs, then publishing when it passes</li>
                </ul>
              ) : (
                <ul className="ticks">
                  <li>The full spec, written from your sentence</li>
                  <li>A test suite with real tasks and attacks</li>
                  <li>Up to {RUNS_PER_ROUND} full test runs while you tune it</li>
                  <li>Publishing, when it passes</li>
                </ul>
              )}
              <p className="hint">The fee pays the AI that builds and tests your agent, so nobody pre-funds it. It goes in one USDC payment you approve in Phantom.</p>
            </div>
            {w.session ? (
              <div className="panel">
                <div className="panel__head">
                  <span className="h4">Your workshop</span>
                  <button className="link" type="button" onClick={() => signOut()}>
                    Sign out {shortAddr(w.session)}
                  </button>
                </div>
                {me?.drafts?.length || me?.agents?.length ? (
                  <ul className="mine">
                    {(me?.drafts ?? []).map((d) => (
                      <li key={d.id}>
                        <button type="button" onClick={() => go(d.id)}>
                          <b>{d.name ?? d.sentence.slice(0, 48)}</b>
                          <span>draft, {d.status.replace('_', ' ')}</span>
                        </button>
                      </li>
                    ))}
                    {(me?.agents ?? []).map((a) => (
                      <li key={a.slug}>
                        <Link href={`/agents/${a.slug}`}>
                          <b>{a.name}</b>
                          <span>
                            {a.status}, {a.stats.paidCalls} paid calls
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="panel__body hint" style={{ margin: 0 }}>
                    Your drafts and live agents will be listed here. {me?.tier ? `Your plan holds ${me.tier.liveAgents} live agents.` : ''}
                  </p>
                )}
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    );
  }

  const d = draft;
  const run = d.run;
  const fresh = d.specHashTested && run && run.finishedAt;
  return (
    <div className="build-draft">
      <div className="build-draft__top">
        <Steps status={d.status} remix={Boolean(d.remix)} improve={Boolean(d.improve)} />
        <button className="link" type="button" onClick={() => go(null)}>
          All drafts
        </button>
      </div>
      <div className="order order--wide">
        <span className="order__head">
          <span>{d.improve ? `v${d.improve.nextVersion} of ${d.improve.agent.name}` : d.remix ? `Remix of ${d.remix.parent.name}` : 'Work order'}</span>
          <span>
            AI used {usd(d.aiSpent)} of {usd(d.aiBudget)}
          </span>
        </span>
        <blockquote>{d.sentence}</blockquote>
      </div>
      {error ? <div className="notice notice--fail">{error}</div> : null}
      {d.error ? <div className="notice notice--fail">{d.error}</div> : null}

      {d.status === 'spec_pending' ? (
        d.improve ? (
          <Working title={`Writing v${d.improve.nextVersion}`} note={`Starting from v${d.improve.fromVersion} of ${d.improve.agent.name}, Fabrica changes only what your sentence asks for.`} />
        ) : d.remix ? (
          <Working title="Writing your version" note={`Starting from ${d.remix.parent.name}, Fabrica changes only what your sentence asks for.`} />
        ) : (
          <Working title="Writing the spec" note="Brief, system prompt, tools, contract and price, from your sentence." />
        )
      ) : null}
      {d.remix && d.spec && d.status !== 'spec_pending' ? <RemixDiff before={d.remix.before} after={d.spec} parentSlug={d.remix.parent.slug} summary={d.remix.summary} /> : null}
      {d.improve && d.spec && d.status !== 'spec_pending' ? <RemixDiff before={d.improve.before} after={d.spec} parentSlug={d.improve.agent.slug} summary={d.improve.summary} labels={{ origin: `v${d.improve.fromVersion}`, before: `v${d.improve.fromVersion}`, after: `v${d.improve.nextVersion}` }} /> : null}
      {d.status === 'failed' ? (
        <div className="panel panel__body">
          <button className="btn btn--primary" type="button" disabled={busy} onClick={() => step(async () => (await api(`/api/drafts/${d.id}/respec`, { body: {} }), void loadDraft(d.id)))}>
            Try writing the spec again
          </button>
        </div>
      ) : null}

      {d.spec && d.status !== 'spec_pending' ? (
        <section className="panel build-block">
          <div className="panel__head">
            <h2 className="h4">The spec</h2>
            <span className="hint">Edit anything. Changes to behaviour need a new test run.</span>
          </div>
          <div className="panel__body">
            <SpecEditor
              spec={d.spec}
              price={d.price}
              busy={busy || d.status === 'running'}
              onSave={(spec) =>
                step(async () => {
                  const r = await api<{ draft: Draft }>(`/api/drafts/${d.id}/spec`, { method: 'PUT', body: { spec } });
                  setDraft(r.body.draft);
                })
              }
            />
          </div>
        </section>
      ) : null}

      {d.status === 'spec' ? (
        <div className="build-next">
          <span>Happy with the spec? Fabrica writes task tests and adds its safety tests.</span>
          <button className="btn btn--primary btn--lg" type="button" disabled={busy} onClick={() => step(async () => (await api(`/api/drafts/${d.id}/tests`, { body: {} }), void loadDraft(d.id)))}>
            Write the tests <IconArrow />
          </button>
        </div>
      ) : null}
      {d.status === 'tests_pending' ? <Working title="Writing the tests" note="Real tasks with checkable answers, then the attacks every agent must survive." /> : null}

      {d.tests.length && d.status !== 'tests_pending' ? (
        <section className="panel build-block">
          <div className="panel__head">
            <h2 className="h4">Tests</h2>
            {run && run.finishedAt ? (
              <span className={run.publishable ? 'pass' : 'fail'}>
                {run.passed}/{run.total} passed{d.specHashTested ? '' : ', before your last change'}
              </span>
            ) : (
              <span className="hint">{d.tests.length} tests</span>
            )}
          </div>
          <div className="panel__body">
            <TestsPanel
              draft={d}
              busy={busy}
              onRun={() => step(async () => (await api(`/api/drafts/${d.id}/run`, { body: {} }), void loadDraft(d.id)))}
              onEdit={(b) => step(async () => (await api(`/api/drafts/${d.id}/tests`, { method: 'PUT', body: b }), void loadDraft(d.id)))}
            />
          </div>
        </section>
      ) : null}

      {d.status === 'tested' && fresh ? (
        run!.publishable ? (
          <div className="build-next build-next--pass">
            {d.improve ? (
              <span>
                <b>Passed.</b> {run!.taskPassed}/{run!.taskTotal} tasks and every safety test. Publishing makes v{d.improve.nextVersion} live on the same page, with the same receipts and earnings, at {d.price ? usd(d.price.total) : ''} per call. Calls already quoted finish on the version they were quoted on.
              </span>
            ) : (
              <span>
                <b>Passed.</b> {run!.taskPassed}/{run!.taskTotal} tasks and every safety test. Publishing opens it for paid calls at {d.price ? usd(d.price.total) : ''} per call, paid straight to your wallet
                {d.price?.royalty ? `, with ${usd(d.price.royalty)} of each call to the maker of ${d.remix?.parent.name ?? 'the original'} in the same payment` : ''}.
              </span>
            )}
            <button
              className="btn btn--primary btn--lg"
              type="button"
              disabled={busy}
              onClick={() =>
                step(async () => {
                  const r = await api<{ slug: string }>(`/api/drafts/${d.id}/publish`, { body: {} });
                  window.location.href = d.improve ? `/agents/${r.body.slug}#versions` : `/agents/${r.body.slug}`;
                })
              }
            >
              {d.improve ? `Publish v${d.improve.nextVersion}` : 'Publish'} <IconArrow />
            </button>
          </div>
        ) : (
          <div className="build-next build-next--fail">
            <span>
              <b>Not yet.</b> Every safety test must pass and at least 80 percent of the task tests. Open the failing tests above, adjust the spec, and run again.
            </span>
          </div>
        )
      ) : null}
      {d.runsUsed >= RUNS_PER_ROUND && d.status !== 'running' && d.status !== 'published' ? (
        <div className="build-next">
          <span>This round&apos;s {RUNS_PER_ROUND} test runs are used. Another round adds {RUNS_PER_ROUND} more and more AI budget.</span>
          <button className="btn" type="button" disabled={busy} onClick={() => step(async () => (await payAndPost(`/api/drafts/${d.id}/topup`, {}, w.session!), void loadDraft(d.id)))}>
            Add a round for {usd(d.buildFee)}
          </button>
        </div>
      ) : null}
      {d.status === 'published' && d.agentSlug ? (
        <div className="build-next build-next--pass">
          <span>
            <b>Live.</b> {d.improve ? 'This version is published on your agent\u2019s page.' : 'Your agent takes paid calls now.'}
          </span>
          <Link className="btn btn--primary" href={d.improve ? `/agents/${d.agentSlug}#versions` : `/agents/${d.agentSlug}`}>
            Open its page <IconArrow />
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/** The live version a new one starts from, and what it keeps. */
function ImproveCurrent({ improve }: { improve: ImproveStart }) {
  return (
    <div className="panel remix-orig">
      <div className="panel__head">
        <span className="h4">Live now: v{improve.version}</span>
        <span className="badge badge--live">Live</span>
      </div>
      <div className="panel__body">
        <Link className="remix-orig__name" href={`/agents/${improve.slug}#versions`}>
          {improve.name}
        </Link>
        <p className="hint">{improve.tagline}</p>
        <div className="remix-orig__facts">
          <span>
            <i>Tasks</i>
            {improve.tests ? `${improve.tests.taskPassed}/${improve.tests.taskTotal}` : 'None'}
          </span>
          <span>
            <i>Safety</i>
            {improve.tests ? `${improve.tests.safetyPassed}/${improve.tests.safetyTotal}` : 'None'}
          </span>
          <span>
            <i>Paid calls</i>
            {improve.paidCalls}
          </span>
        </div>
        <p className="remix-orig__deal">v{improve.next} keeps this page, its receipts, earnings, coin and remixes. v{improve.version} stays on record, and you can make it live again in one click.</p>
      </div>
    </div>
  );
}

/** The original a remix starts from, and what the remix will owe it. */
function RemixOriginal({ remix, wallet }: { remix: RemixStart; wallet: string | null }) {
  const own = Boolean(wallet && remix.maker === wallet);
  const royalty = royaltyOf(remix.makerFee, REMIX_ROYALTY_BPS);
  return (
    <div className="panel remix-orig">
      <div className="panel__head">
        <span className="h4">The original</span>
        <span className="hint">{remix.example ? 'Example by Fabrica' : `by ${shortAddr(remix.maker)}`}</span>
      </div>
      <div className="panel__body">
        <Link className="remix-orig__name" href={`/agents/${remix.slug}`}>
          {remix.name}
        </Link>
        <p className="hint">{remix.tagline}</p>
        <div className="remix-orig__facts">
          <span>
            <i>Tests</i>
            {remix.tests ? `${remix.tests.passed}/${remix.tests.total}` : 'None'}
          </span>
          <span>
            <i>Per call</i>
            {usd(remix.price.total)}
          </span>
        </div>
        <p className="remix-orig__deal">
          {remix.example
            ? 'Examples have no maker wallet, so your version pays no royalty. You keep all of your earnings per call.'
            : own
              ? 'This is your own agent, so your version pays no royalty.'
              : `Once your version is live, ${REMIX_ROYALTY_BPS / 100}% of your earnings per call go to its maker in the same payment: ${usd(royalty)} of ${usd(remix.makerFee)} at today's price. Callers pay the same.`}
        </p>
      </div>
    </div>
  );
}
