'use client';
// A remix's before and after: every part of the spec the change touched, the original's next to the remix's.
// Computed from the two specs in the browser, so the maker's own edits show here as soon as they are saved.
import Link from 'next/link';
import type { AgentSpec } from '../../shared/types';
import { specChanges } from '../../shared/remix';

export function RemixDiff({ before, after, parentSlug, summary }: { before: AgentSpec; after: AgentSpec; parentSlug: string; summary: string | null }) {
  const changes = specChanges(before, after);
  return (
    <section className="panel build-block rdiff" id="before-after">
      <div className="panel__head">
        <h2 className="h4">Before and after</h2>
        <span className="hint">
          {changes.length} {changes.length === 1 ? 'part' : 'parts'} changed from{' '}
          <Link className="link" href={`/agents/${parentSlug}`}>
            {before.name}
          </Link>
        </span>
      </div>
      <div className="panel__body rdiff__body">
        {summary ? <p className="rdiff__summary">{summary}</p> : null}
        {changes.map((c) =>
          c.field === 'systemPrompt' || c.lines.length > 4 ? (
            <div key={c.field} className="rdiff__row rdiff__row--lines">
              <span className="label">
                {c.label}
                {c.behaviour ? <i className="rdiff__tag">changes what it does</i> : null}
              </span>
              <ol className="rdiff__lines">
                {c.lines
                  .filter((l, i, all) => l.op !== 'same' || all.slice(Math.max(0, i - 1), i + 2).some((x) => x.op !== 'same'))
                  .map((l, i) => (
                    <li key={i} className={`rdiff__line rdiff__line--${l.op}`}>
                      <span aria-hidden="true">{l.op === 'add' ? '+' : l.op === 'del' ? '-' : ' '}</span>
                      <span>{l.text || ' '}</span>
                    </li>
                  ))}
              </ol>
            </div>
          ) : (
            <div key={c.field} className="rdiff__row">
              <span className="label">
                {c.label}
                {c.behaviour ? <i className="rdiff__tag">changes what it does</i> : null}
              </span>
              <div className="rdiff__pair">
                <div className="rdiff__side rdiff__side--before">
                  <span className="rdiff__k">Before</span>
                  {c.lines.filter((l) => l.op !== 'add').map((l, i) => (
                    <span key={i} className={l.op === 'del' ? 'is-gone' : ''}>
                      {l.text}
                    </span>
                  ))}
                </div>
                <div className="rdiff__side rdiff__side--after">
                  <span className="rdiff__k">After</span>
                  {c.lines.filter((l) => l.op !== 'del').map((l, i) => (
                    <span key={i} className={l.op === 'add' ? 'is-new' : ''}>
                      {l.text}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ),
        )}
      </div>
    </section>
  );
}
