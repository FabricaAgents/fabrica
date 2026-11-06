'use client';
// The hero machine: a sentence goes in on a work order, rides the line through four stations and leaves as a
// working agent. Every name, tool, test and price shown is a real example agent from the database.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolName } from '../../shared/types';
import { usd } from '../../shared/format';
import { ToolIcon, TOOL_LABEL } from '../Icons';

export interface LineUnit {
  slug: string;
  name: string;
  sentence: string;
  category: string;
  tools: ToolName[];
  input: string[];
  output: string[];
  tests: { title: string; kind: string; pass: boolean }[];
  taskPassed: number;
  taskTotal: number;
  safetyPassed: number;
  safetyTotal: number;
  price: number;
  model: string;
}

const STATIONS = ['Spec', 'Tools', 'Tests', 'Live'] as const;
// Milliseconds each phase lasts: typing, then the four stations, then shipping out.
const PHASE_MS = [2600, 2300, 1900, 3400, 2600, 900];

export function Line({ units }: { units: LineUnit[] }) {
  const [i, setI] = useState(0);
  const [phase, setPhase] = useState(0);
  const [typed, setTyped] = useState(0);
  const [ticks, setTicks] = useState(0);
  const reduced = useRef(false);
  const unit = units[i % Math.max(units.length, 1)];

  useEffect(() => {
    reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  // The phase clock.
  useEffect(() => {
    if (!unit) return;
    if (reduced.current) {
      setPhase(4);
      setTyped(unit.sentence.length);
      setTicks(unit.tests.length);
      return;
    }
    const t = setTimeout(() => {
      if (phase >= PHASE_MS.length - 1) {
        setPhase(0);
        setTyped(0);
        setTicks(0);
        setI((x) => x + 1);
      } else setPhase(phase + 1);
    }, PHASE_MS[phase]);
    return () => clearTimeout(t);
  }, [phase, unit]);

  // Typing the work order.
  useEffect(() => {
    if (!unit || phase !== 0 || reduced.current) return;
    if (typed >= unit.sentence.length) return;
    const t = setTimeout(() => setTyped((n) => Math.min(unit.sentence.length, n + 2 + Math.round(Math.random()))), 22);
    return () => clearTimeout(t);
  }, [typed, phase, unit]);

  // Test lines ticking during the test station.
  useEffect(() => {
    if (!unit || phase !== 3 || reduced.current) return;
    if (ticks >= unit.tests.length) return;
    const t = setTimeout(() => setTicks((n) => n + 1), Math.max(120, 2600 / unit.tests.length));
    return () => clearTimeout(t);
  }, [ticks, phase, unit]);

  const station = phase - 1; // -1 while typing, 4 while shipping
  const order = useMemo(() => 140 + (i % 60), [i]);
  if (!unit) return null;
  const shown = phase === 0 ? unit.sentence.slice(0, typed) : unit.sentence;
  const testsShown = phase > 3 || phase === 5 ? unit.tests.length : phase === 3 ? ticks : 0;
  const passedShown = unit.tests.slice(0, testsShown).filter((t) => t.pass).length;

  return (
    <div className="machine" aria-label={`Example: ${unit.name} built from one sentence`}>
      <div className="machine__bar">
        <span className="machine__title">Line 01</span>
        <span className="machine__lights" aria-hidden="true">
          <i className={phase === 0 ? 'on' : ''} />
          <i className={phase > 0 && phase < 5 ? 'on' : ''} />
          <i className={phase === 5 ? 'on ok' : ''} />
        </span>
        <span className="machine__order">Order {String(order).padStart(4, '0')}</span>
      </div>

      <div className={`ticket ${phase === 5 ? 'is-out' : ''}`}>
        <div className="ticket__head">
          <span>Work order</span>
          <span>{unit.category}</span>
        </div>
        <p className="ticket__text">
          {shown}
          {phase === 0 ? <span className="caret" /> : null}
        </p>
      </div>

      <div className="belt">
        <div className="belt__stations">
          {STATIONS.map((s, k) => (
            <div key={s} className={`station ${station === k ? 'is-active' : ''} ${station > k ? 'is-done' : ''}`}>
              <span className="station__led" />
              <span className="station__n">0{k + 1}</span>
              <span className="station__name">{s}</span>
            </div>
          ))}
        </div>
        <div className="belt__track" aria-hidden="true">
          <div className={`belt__carrier p${Math.max(0, Math.min(station, 3))} ${phase === 0 ? 'is-wait' : ''} ${phase === 5 ? 'is-ship' : ''}`} />
        </div>
      </div>

      <div className="readout" key={`${i}-${Math.min(Math.max(station, 0), 3)}`}>
        {station <= 0 ? (
          <div className="readout__pane">
            <div className="readout__label">Spec</div>
            <div className={`readout__name ${phase === 0 ? 'is-ghost' : ''}`}>{phase === 0 ? 'Reading the order' : unit.name}</div>
            <div className="readout__io">
              <div>
                <span className="readout__k">In</span>
                {(phase === 0 ? ['...'] : unit.input).map((f) => (
                  <code key={f}>{f}</code>
                ))}
              </div>
              <div>
                <span className="readout__k">Out</span>
                {(phase === 0 ? ['...'] : unit.output.slice(0, 5)).map((f) => (
                  <code key={f}>{f}</code>
                ))}
                {phase > 0 && unit.output.length > 5 ? <code className="more">+{unit.output.length - 5}</code> : null}
              </div>
            </div>
          </div>
        ) : null}
        {station === 1 ? (
          <div className="readout__pane">
            <div className="readout__label">Tools, least privilege</div>
            <div className="readout__tools">
              {unit.tools.length ? (
                unit.tools.map((t, k) => (
                  <span key={t} className="tool-chip" style={{ animationDelay: `${k * 220}ms` }}>
                    <ToolIcon tool={t} />
                    {TOOL_LABEL[t]}
                  </span>
                ))
              ) : (
                <span className="tool-chip">No tools: text in, JSON out</span>
              )}
            </div>
            <div className="readout__note">Model: {unit.model.split('/')[1]}. Sandbox, no host files, network only where the spec allows it.</div>
          </div>
        ) : null}
        {station === 2 ? (
          <div className="readout__pane">
            <div className="readout__label">
              Tests <span className="readout__count">{passedShown}/{unit.tests.length} passed</span>
            </div>
            <ul className="readout__tests">
              {unit.tests.slice(0, 7).map((t, k) => (
                <li key={t.title} className={k < testsShown ? (t.pass ? 'is-pass' : 'is-fail') : ''}>
                  <span className="tmark" />
                  <span className="tkind">{t.kind === 'task' || t.kind === 'robustness' ? 'task' : t.kind.replace('_', ' ')}</span>
                  <span className="ttitle">{t.title}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {station >= 3 ? (
          <div className="readout__pane">
            <div className="readout__label">Priced to pay its own way</div>
            <div className="readout__live">
              <div>
                <div className="readout__price">{usd(unit.price)}</div>
                <div className="readout__k">per call, USDC</div>
              </div>
              <div className="readout__flow">
                <span>
                  <b>402</b> quote
                </span>
                <span>
                  <b>pay</b> one transaction
                </span>
                <span>
                  <b>200</b> answer and receipt
                </span>
              </div>
            </div>
            <code className="readout__endpoint">POST /api/agents/{unit.slug}/run</code>
          </div>
        ) : null}
      </div>
    </div>
  );
}
