import Link from 'next/link';
import type { AgentPublic } from '../shared/types';
import { compact, usd } from '../shared/format';
import { ToolIcon, TOOL_LABEL } from './Icons';

export function StatusBadge({ a }: { a: Pick<AgentPublic, 'status' | 'example'> }) {
  if (a.example) return <span className="badge badge--example">Example</span>;
  if (a.status === 'paused') return <span className="badge badge--paused">Paused</span>;
  return <span className="badge badge--live">Live</span>;
}

export function AgentCard({ a, rank }: { a: AgentPublic; rank?: number }) {
  return (
    <Link href={`/agents/${a.slug}`} className="acard card">
      <div className="acard__top">
        <span className="kicker kicker--plain">
          {rank ? <span className="acard__rank">#{rank}</span> : null}
          {a.category}
        </span>
        <StatusBadge a={a} />
      </div>
      <h3 className="h3 acard__name">{a.name}</h3>
      <p className="acard__tag">
        {a.remixOf ? <span className="acard__remix">Remix of {a.remixOf.name}. </span> : null}
        {a.tagline}
      </p>
      <div className="chips">
        {a.tools.length ? (
          a.tools.map((t) => (
            <span key={t} className="chip">
              <ToolIcon tool={t} />
              {TOOL_LABEL[t]}
            </span>
          ))
        ) : (
          <span className="chip">Text in, JSON out</span>
        )}
      </div>
      <div className="acard__foot">
        <div>
          <span className="acard__k">Tests</span>
          <b className={a.tests && a.tests.passed === a.tests.total ? 'pass' : ''}>{a.tests ? `${a.tests.passed}/${a.tests.total}` : 'None'}</b>
        </div>
        <div>
          <span className="acard__k">Per call</span>
          <b>{usd(a.price.total)}</b>
        </div>
        <div>
          <span className="acard__k">{a.example ? 'Calls' : 'Paid calls'}</span>
          <b>{a.example ? 'Not for sale' : compact(a.stats.paidCalls)}</b>
        </div>
      </div>
    </Link>
  );
}
