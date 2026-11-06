import Link from 'next/link';
import type { Metadata } from 'next';
import { ROADMAP, type PhaseState } from '../../shared/roadmap';
import { IconArrow } from '../../components/Icons';

export const metadata: Metadata = { title: 'Roadmap', description: 'Where Fabrica is going, phase by phase: the factory, remix and versions, agent networks, agents beyond text and Fabrica for teams.' };

const LABEL: Record<PhaseState, string> = { live: 'Live', next: 'Next', planned: 'Planned' };

export default function Roadmap() {
  const live = ROADMAP.filter((p) => p.state === 'live').length;
  const next = ROADMAP.find((p) => p.state === 'next');
  const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const liveLine = live === 1 ? 'Phase 1 is live' : `${WORDS[live] ?? live} phases are live`;
  return (
    <>
      <section className="page-head grid-bg">
        <div className="wrap">
          <span className="kicker">Roadmap</span>
          <h1 className="display h1" style={{ marginTop: 18 }}>
            Five phases. One factory.
          </h1>
          <p className="lede">
            Each phase builds one part of Fabrica, on top of the last. {liveLine}
            {next ? `, ${next.name} is next` : ''}; the rest are planned, with no dates, and new phases are added as we go.
          </p>
          <div className="hero__ctas">
            <Link className="btn btn--primary btn--lg" href="/build">
              Build an agent <IconArrow />
            </Link>
            <Link className="btn btn--ghost btn--lg" href="/agents">
              See the agents
            </Link>
          </div>
        </div>
      </section>

      <section className="section--tight">
        <div className="wrap">
          <ol className="rm">
            {ROADMAP.map((p, i) => (
              <li key={p.name} className={`rm__phase rm__phase--${p.state}`}>
                <div className="rm__rail" aria-hidden="true">
                  <span className="rm__dot" />
                </div>
                <div className="rm__body">
                  <div className="rm__head">
                    <span className="rm__num">Phase {String(i + 1).padStart(2, '0')}</span>
                    <span className="rm__focus">{p.focus}</span>
                    <span className={`rm__state rm__state--${p.state}`}>{LABEL[p.state]}</span>
                  </div>
                  <h2 className="rm__name display">{p.name}</h2>
                  <p className="rm__line">{p.line}</p>
                  <ul className="rm__items">
                    {p.items.map((it) => (
                      <li key={it.name} className="rm__item">
                        <b>
                          {it.name}
                          {it.state === 'next' ? <span className="rm__tag">Next</span> : it.state === 'live' && p.state !== 'live' ? <span className="rm__tag rm__tag--live">Live</span> : null}
                        </b>
                        <span>{it.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
          <p className="rm__note">Planned work is a plan, not a promise of a date. Every item ships only when it works and its tests pass.</p>
        </div>
      </section>
    </>
  );
}
