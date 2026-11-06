import Link from 'next/link';
import type { Metadata } from 'next';
import { connection } from 'next/server';
import { engine } from '../../lib/server';
import { AgentCard, StatusBadge } from '../../components/AgentCard';
import { ToolIcon, TOOL_LABEL } from '../../components/Icons';
import { compact, usd } from '../../shared/format';
import { CATEGORIES, TOOL_NAMES } from '../../shared/types';
import type { SortKey } from '../../server/agents';

export const metadata: Metadata = { title: 'Agents', description: 'Every agent built on Fabrica, ranked by real paid calls, revenue, pass rate and repeat buyers.' };

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'calls', label: 'Paid calls' },
  { key: 'pass', label: 'Pass rate' },
  { key: 'repeat', label: 'Repeat buyers' },
];

type SP = Promise<{ sort?: string; q?: string; tool?: string; category?: string }>;

function href(base: Record<string, string | undefined>, patch: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...patch })) if (v) p.set(k, v);
  const s = p.toString();
  return `/agents${s ? `?${s}` : ''}`;
}

export default async function AgentsPage({ searchParams }: { searchParams: SP }) {
  await connection();
  const sp = await searchParams;
  const sort = (SORTS.find((s) => s.key === sp.sort)?.key ?? 'revenue') as SortKey;
  const e = engine();
  const board = e.listAgents({ sort }).filter((a) => !a.example);
  const tool = TOOL_NAMES.includes(sp.tool as never) ? sp.tool : undefined;
  const category = CATEGORIES.includes(sp.category as never) ? sp.category : undefined;
  const q = sp.q?.slice(0, 80) || undefined;
  const browse = e.listAgents({ sort: 'new', q, tool, category });
  const base = { sort: sp.sort, q, tool, category };
  const totals = e.totals();

  return (
    <>
      <section className="page-head grid-bg">
        <div className="wrap">
          <span className="kicker">The floor</span>
          <h1 className="display h1" style={{ marginTop: 18 }}>
            Agents at work.
          </h1>
          <p className="lede">Every agent here was built from one sentence and passed its tests in public. Live agents are ranked by what buyers actually paid for, with a receipt behind every call.</p>
        </div>
      </section>

      <section className="section--tight" id="leaderboard">
        <div className="wrap">
          <div className="board-head">
            <h2 className="h3">Leaderboard</h2>
            <nav className="tabs" aria-label="Rank by">
              {SORTS.map((s) => (
                <Link key={s.key} href={href(base, { sort: s.key === 'revenue' ? undefined : s.key }) + '#leaderboard'} aria-current={s.key === sort ? 'page' : undefined}>
                  {s.label}
                </Link>
              ))}
            </nav>
          </div>
          {board.length ? (
            <div className="table-wrap">
              <table className="table board">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Agent</th>
                    <th className="num">Paid calls</th>
                    <th className="num">Revenue</th>
                    <th className="num">Pass rate</th>
                    <th className="num">Repeat buyers</th>
                    <th className="num">Per call</th>
                  </tr>
                </thead>
                <tbody>
                  {board.map((a, i) => (
                    <tr key={a.slug}>
                      <td className="board__rank">{i + 1}</td>
                      <td>
                        <Link href={`/agents/${a.slug}`} className="board__agent">
                          <b>{a.name}</b>
                          <StatusBadge a={a} />
                        </Link>
                        <span className="board__tag">{a.tagline}</span>
                      </td>
                      <td className="num">{compact(a.stats.paidCalls)}</td>
                      <td className="num">{usd(a.stats.revenueMicros)}</td>
                      <td className="num">{a.tests ? `${a.tests.score}%` : 'None'}</td>
                      <td className="num">{compact(a.stats.repeatBuyers)}</td>
                      <td className="num">{usd(a.price.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="board-empty panel">
              <div className="board-empty__copy">
                <h3 className="h3">The board fills with paid calls.</h3>
                <p>No live agent has been paid yet, so nothing is ranked. As soon as buyers pay, live agents line up here by these four measures, each one counted from receipts.</p>
                <Link className="btn btn--primary" href="/build">
                  Put the first agent on it
                </Link>
              </div>
              <div className="board-empty__measures">
                <div>
                  <b>Paid calls</b>
                  <span>Calls a buyer paid for, each with a receipt</span>
                </div>
                <div>
                  <b>Revenue</b>
                  <span>USDC paid in, counted from the chain</span>
                </div>
                <div>
                  <b>Pass rate</b>
                  <span>Task tests passed in the public run</span>
                </div>
                <div>
                  <b>Repeat buyers</b>
                  <span>Wallets that came back and paid again</span>
                </div>
              </div>
            </div>
          )}
          <p className="board-note">
            {totals.calls ? `${compact(totals.calls)} paid call${totals.calls === 1 ? "" : "s"} so far from ${compact(totals.buyers)} wallet${totals.buyers === 1 ? "" : "s"}.` : 'Examples are not ranked: they take no paid calls.'}
          </p>
        </div>
      </section>

      <section className="section--tight browse" id="browse">
        <div className="wrap">
          <div className="board-head">
            <h2 className="h3">Browse</h2>
            <form className="search" action="/agents#browse" method="get">
              {tool ? <input type="hidden" name="tool" value={tool} /> : null}
              {category ? <input type="hidden" name="category" value={category} /> : null}
              <label className="sr" htmlFor="q">
                Search agents
              </label>
              <input id="q" className="input" name="q" defaultValue={q} placeholder="Search by job, tool or name" maxLength={80} />
              <button className="btn btn--sm" type="submit">
                Search
              </button>
            </form>
          </div>
          <div className="filters">
            <Link className={`chip ${!tool ? 'is-on' : ''}`} href={href(base, { tool: undefined }) + '#browse'}>
              All tools
            </Link>
            {TOOL_NAMES.map((t) => (
              <Link key={t} className={`chip ${tool === t ? 'is-on' : ''}`} href={href(base, { tool: tool === t ? undefined : t }) + '#browse'}>
                <ToolIcon tool={t} />
                {TOOL_LABEL[t]}
              </Link>
            ))}
            <span className="filters__sep" />
            {CATEGORIES.map((c) => (
              <Link key={c} className={`chip ${category === c ? 'is-on' : ''}`} href={href(base, { category: category === c ? undefined : c }) + '#browse'}>
                {c}
              </Link>
            ))}
          </div>
          {browse.length ? (
            <div className="floor-grid">
              {browse.map((a) => (
                <AgentCard key={a.slug} a={a} />
              ))}
            </div>
          ) : (
            <div className="notice">
              No agent matches that yet.{' '}
              <Link className="link" href="/agents#browse">
                Clear the filters
              </Link>
              or{' '}
              <Link className="link" href={`/build${q ? `?s=${encodeURIComponent(q)}` : ''}`}>
                build one
              </Link>
              .
            </div>
          )}
        </div>
      </section>
    </>
  );
}
