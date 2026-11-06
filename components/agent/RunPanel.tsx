'use client';
// The run-it page: a form built from the agent's input contract, one payment in Phantom, the answer and its receipt.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FieldSpec, PaymentRequirements, PriceBreakdown, Receipt } from '../../shared/types';
import { shortAddr, solscanTx, usd } from '../../shared/format';
import { api, ApiError } from '../../lib/api';
import { payRequirements, PayError } from '../../lib/pay';
import { connect, useWallet } from '../../lib/wallet';
import { IconArrow, IconCheck, IconReceipt, IconWallet } from '../Icons';

type Value = string | boolean;

function initial(fields: FieldSpec[], ex?: Record<string, unknown>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const f of fields) {
    const v = ex?.[f.name];
    if (f.type === 'boolean') out[f.name] = Boolean(v);
    else if (f.type === 'string[]') out[f.name] = Array.isArray(v) ? v.join('\n') : '';
    else if (f.type === 'object') out[f.name] = v ? JSON.stringify(v, null, 2) : '';
    else out[f.name] = v === undefined || v === null ? '' : String(v);
  }
  return out;
}

function toInput(fields: FieldSpec[], vals: Record<string, Value>): { input: Record<string, unknown>; error: string | null } {
  const input: Record<string, unknown> = {};
  for (const f of fields) {
    const v = vals[f.name];
    if (f.type === 'boolean') {
      input[f.name] = Boolean(v);
      continue;
    }
    const s = String(v ?? '').trim();
    if (!s) {
      if (f.required) return { input, error: `Fill in ${f.name.replace(/_/g, ' ')}.` };
      continue;
    }
    if (f.type === 'number' || f.type === 'integer') {
      const n = Number(s);
      if (!Number.isFinite(n) || (f.type === 'integer' && !Number.isInteger(n))) return { input, error: `${f.name} must be a ${f.type === 'integer' ? 'whole ' : ''}number.` };
      input[f.name] = n;
    } else if (f.type === 'string[]') input[f.name] = s.split('\n').map((x) => x.trim()).filter(Boolean);
    else if (f.type === 'object') {
      try {
        input[f.name] = JSON.parse(s);
      } catch {
        return { input, error: `${f.name} must be JSON.` };
      }
    } else input[f.name] = String(v);
  }
  return { input, error: null };
}

const STAGES: Record<string, string> = {
  quote: 'Getting the price',
  sign: 'Approve the payment in Phantom',
  verifying: 'Checking the payment',
  sending: 'Sending the payment',
  confirming: 'Waiting for the payment to confirm',
  confirmed: 'Payment confirmed',
  queued: 'Waiting for a free slot',
  running: 'The agent is working',
  done: 'Done',
  failed: 'The run failed',
};

function Output({ value }: { value: Record<string, unknown> }) {
  const files = Array.isArray(value._files) ? (value._files as { name: string; url: string }[]) : [];
  return (
    <dl className="out">
      {Object.entries(value)
        .filter(([k]) => k !== '_files')
        .map(([k, v]) => (
          <div key={k} className="out__row">
            <dt>{k.replace(/_/g, ' ')}</dt>
            <dd>
              {typeof v === 'string' ? (
                v
              ) : Array.isArray(v) && v.every((x) => typeof x !== 'object') ? (
                v.length ? (
                  <ul>
                    {v.map((x, i) => (
                      <li key={i}>{String(x)}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="muted">none</span>
                )
              ) : (
                <code>{JSON.stringify(v)}</code>
              )}
            </dd>
          </div>
        ))}
      {files.map((f) => (
        <div key={f.url} className="out__row">
          <dt>file</dt>
          <dd>
            <a className="link" href={f.url} download>
              {f.name}
            </a>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function RunPanel(props: {
  slug: string;
  name: string;
  fields: FieldSpec[];
  examples: { title: string; input: Record<string, unknown> }[];
  price: PriceBreakdown;
  canRun: boolean;
  blocked: string | null;
  sample: { input: Record<string, unknown>; output: Record<string, unknown> } | null;
}) {
  const wallet = useWallet();
  const [vals, setVals] = useState<Record<string, Value>>(() => initial(props.fields, props.examples[0]?.input));
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ output: Record<string, unknown> | null; receipt: Receipt; retryToken?: string; message?: string } | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const busy = stage !== null && stage !== 'done' && stage !== 'failed';
  useEffect(() => () => void (poll.current && clearInterval(poll.current)), []);
  const showing = result?.output ?? (!result && !props.canRun ? props.sample?.output : null);

  const startPoll = (nonce: string) => {
    poll.current && clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const { body } = await api<{ stage: string; events: { detail: string; type: string }[] }>(`/api/runs/${nonce}`);
        if (body.stage && body.stage !== 'unknown') setStage((s) => (s === 'done' || s === 'failed' ? s : body.stage));
        setEvents(body.events.filter((e) => e.type === 'tool').map((e) => e.detail));
      } catch {
        /* the final answer arrives on the main request */
      }
    }, 700);
  };

  const run = async (retryToken?: string) => {
    setError(null);
    setResult(null);
    setEvents([]);
    const { input, error: bad } = toInput(props.fields, vals);
    if (bad) return setError(bad);
    try {
      if (retryToken) {
        setStage('running');
        const r = await api(`/api/agents/${props.slug}/run`, { body: { input }, headers: { 'x-fabrica-retry': retryToken } });
        setResult(r.body);
        setStage('done');
        return;
      }
      const payer = wallet.address ?? (await connect());
      if (!payer) return;
      setStage('quote');
      const q = await api<{ accepts: PaymentRequirements[] }>(`/api/agents/${props.slug}/run`, { body: { input } });
      if (q.status !== 402) throw new Error('Unexpected answer from the server.');
      const req = q.body.accepts[0];
      setStage('sign');
      const header = await payRequirements(req, payer);
      setStage('verifying');
      startPoll(req.extra.nonce);
      const r = await fetch(`/api/agents/${props.slug}/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment': header }, body: JSON.stringify({ input }) });
      const body = await r.json();
      poll.current && clearInterval(poll.current);
      if (r.status === 200) {
        setResult(body);
        setStage('done');
      } else if (body.receipt) {
        setResult({ output: null, receipt: body.receipt, retryToken: body.retryToken, message: body.message });
        setStage('failed');
      } else throw new ApiError(r.status, body.error, body.message ?? 'The call failed.', body);
    } catch (e) {
      poll.current && clearInterval(poll.current);
      setStage(null);
      setError(e instanceof PayError || e instanceof ApiError ? e.message : `Something went wrong: ${(e as Error).message}`);
    }
  };

  const fieldsUi = useMemo(
    () =>
      props.fields.map((f) => {
        const id = `in-${f.name}`;
        const common = { id, name: f.name, disabled: busy };
        const v = vals[f.name];
        const setV = (x: Value) => setVals((s) => ({ ...s, [f.name]: x }));
        let control;
        if (f.type === 'boolean') control = <input {...common} type="checkbox" checked={Boolean(v)} onChange={(e) => setV(e.target.checked)} />;
        else if (f.enum?.length)
          control = (
            <select {...common} className="select" value={String(v)} onChange={(e) => setV(e.target.value)}>
              <option value="">Choose</option>
              {f.enum.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          );
        else if (f.type === 'text' || f.type === 'string[]' || f.type === 'object')
          control = <textarea {...common} className={`textarea ${f.type === 'object' || f.name.includes('csv') ? 'textarea--mono' : ''}`} rows={f.type === 'text' ? 6 : 4} maxLength={f.maxLength} value={String(v)} onChange={(e) => setV(e.target.value)} />;
        else control = <input {...common} className="input" type={f.type === 'number' || f.type === 'integer' ? 'number' : 'text'} step={f.type === 'integer' ? 1 : 'any'} maxLength={f.maxLength} value={String(v)} onChange={(e) => setV(e.target.value)} />;
        return (
          <div key={f.name} className={`field ${f.type === 'boolean' ? 'field--check' : ''}`}>
            <label className="label" htmlFor={id}>
              {f.name.replace(/_/g, ' ')}
              {f.required ? '' : ' (optional)'}
            </label>
            {control}
            <span className="hint">
              {f.description}
              {f.type === 'string[]' ? '. One per line.' : ''}
            </span>
          </div>
        );
      }),
    [props.fields, vals, busy],
  );

  return (
    <div className="run panel" id="run">
      <div className="panel__head">
        <h2 className="h4">Run it</h2>
        <span className="run__price">
          {usd(props.price.total)} <span className="muted">per call</span>
        </span>
      </div>
      <div className="panel__body run__body">
        {props.examples.length ? (
          <div className="chips run__ex">
            <span className="label">Try</span>
            {props.examples.map((ex) => (
              <button key={ex.title} type="button" className="chip chip--btn" disabled={busy} onClick={() => setVals(initial(props.fields, ex.input))}>
                {ex.title}
              </button>
            ))}
          </div>
        ) : null}
        <form
          className="run__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (props.canRun) void run();
          }}
        >
          {fieldsUi}
          {props.canRun ? (
            <div className="run__actions">
              <button className="btn btn--primary btn--lg" type="submit" disabled={busy}>
                {busy ? <span className="spinner" /> : <IconWallet />}
                {busy ? STAGES[stage!] ?? 'Working' : `Pay ${usd(props.price.total)} and run`}
              </button>
              <span className="hint">
                {wallet.address ? `Paying from ${shortAddr(wallet.address)} in USDC. You approve it in Phantom.` : 'Connects Phantom. One USDC payment, approved by you.'}
              </span>
            </div>
          ) : (
            <div className="notice">{props.blocked}</div>
          )}
        </form>
        {busy ? (
          <ol className="run__stages" aria-live="polite">
            {['sign', 'confirming', 'running'].map((s) => (
              <li key={s} className={stage === s || (s === 'confirming' && ['verifying', 'sending', 'confirming', 'confirmed'].includes(stage!)) || (s === 'running' && stage === 'queued') ? 'is-now' : ''}>
                {s === 'sign' ? 'Approve' : s === 'confirming' ? 'Confirm payment' : 'Agent at work'}
              </li>
            ))}
            {events.length ? <li className="run__events">Used: {events.join(', ')}</li> : null}
          </ol>
        ) : null}
        {error ? <div className="notice notice--fail">{error}</div> : null}
        {showing ? (
          <div className="run__result">
            <div className="run__result-head">
              <span className="kicker kicker--plain">{result ? 'Answer' : 'Sample answer from its tests'}</span>
              {result ? (
                <span className="badge badge--pass">
                  <IconCheck /> Paid and done
                </span>
              ) : null}
            </div>
            <Output value={showing as Record<string, unknown>} />
          </div>
        ) : null}
        {result && !result.output ? (
          <div className="notice notice--fail">
            <div>
              <b>The agent did not finish: </b>
              {result.message}
              {result.retryToken ? (
                <div style={{ marginTop: 10 }}>
                  <button className="btn btn--sm" type="button" onClick={() => run(result.retryToken)}>
                    Run again at no charge <IconArrow />
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {result ? (
          <div className="receipt">
            <IconReceipt />
            <div>
              <b>Receipt {result.receipt.id}</b>
              <span>
                {usd(result.receipt.total)} paid: {usd(result.receipt.maker)} to the maker, {result.receipt.royalty ? `${usd(result.receipt.royalty)} royalty to the original maker, ` : ''}
                {usd(result.receipt.ai)} for AI, {usd(result.receipt.platform)} platform fee.{' '}
                <a className="link" href={solscanTx(result.receipt.txSig)} target="_blank" rel="noopener noreferrer">
                  See the transaction
                </a>
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
