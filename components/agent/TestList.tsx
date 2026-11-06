import type { TestResult } from '../../shared/types';
import { durationMs } from '../../shared/format';
import { IconCheck, IconCross } from '../Icons';

const KIND: Record<string, string> = { task: 'Task', robustness: 'Robustness', injection: 'Injection', exfiltration: 'Exfiltration', unsafe_tool: 'Unsafe tool' };

const show = (v: unknown) => (v === null || v === undefined ? 'none' : JSON.stringify(v, null, 2));

export function TestList({ results }: { results: TestResult[] }) {
  const ordered = [...results.filter((r) => r.kind === 'task' || r.kind === 'robustness'), ...results.filter((r) => r.kind !== 'task' && r.kind !== 'robustness')];
  return (
    <div className="tlist">
      {ordered.map((t) => (
        <details key={t.id} className="titem">
          <summary>
            <span className={`ok-box ${t.pass ? '' : 'bad'}`}>{t.pass ? <IconCheck /> : <IconCross />}</span>
            <span className="titem__title">{t.title}</span>
            <span className={`tag-kind ${t.kind === 'task' || t.kind === 'robustness' ? '' : 'adv'}`}>{KIND[t.kind]}</span>
            <span className="titem__ms">{durationMs(t.ms)}</span>
          </summary>
          <div className="titem__body">
            <div className="tcol">
              <span className="label">Input</span>
              <pre className="code code--sm">{show(t.input)}</pre>
            </div>
            <div className="tcol">
              <span className="label">{t.error ? 'Result' : 'Output'}</span>
              <pre className="code code--sm">{t.error ? t.error : show(t.output)}</pre>
            </div>
            <div className="tcol tcol--wide">
              <span className="label">Checks</span>
              <ul className="checks">
                {t.checks.map((c, i) => (
                  <li key={i} className={c.pass ? 'pass' : 'fail'}>
                    <b>{c.pass ? 'pass' : 'fail'}</b> <span className="mono">{c.type}</span> {c.detail}
                  </li>
                ))}
              </ul>
              {t.tools.length ? (
                <>
                  <span className="label" style={{ marginTop: 12, display: 'block' }}>
                    Tool calls
                  </span>
                  <ul className="checks">
                    {t.tools.map((c, i) => (
                      <li key={i} className={c.blocked ? 'fail' : ''}>
                        <span className="mono">{c.tool}</span> {c.summary}
                        {c.blocked ? ' (blocked by the guard)' : ''}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}
