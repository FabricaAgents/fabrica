import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { engine } from '../../../lib/server';
import { BuildFlow } from '../../../components/build/BuildFlow';

type P = Promise<{ slug: string }>;
type SP = Promise<{ s?: string; draft?: string }>;

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  await connection();
  const a = engine().agent((await params).slug);
  return a && !a.example ? { title: `Improve ${a.name}`, description: `Make the next version of ${a.name} with one sentence. It is tested again before it goes live.` } : { title: 'Agent not found' };
}

export default async function ImprovePage({ params, searchParams }: { params: P; searchParams: SP }) {
  await connection();
  const { slug } = await params;
  const sp = await searchParams;
  const e = engine();
  const a = e.agent(slug);
  // Examples have no maker, so nobody can improve them; a remix makes your own version instead.
  if (!a || a.example || !a.maker) notFound();
  const cfg = e.siteConfig();
  const row = e.agentRow(slug)!;
  const next = Math.max(...e.versions.list(row).map((v) => v.version), a.version) + 1;
  const draft = sp.draft && /^d_[A-Za-z0-9_-]{8,20}$/.test(sp.draft) ? sp.draft : null;
  const closed = !cfg.versionsOpen ? 'New versions are paused for now. Live agents keep working.' : null;
  return (
    <>
      <section className="page-head grid-bg">
        <div className="wrap">
          <span className="kicker">Improve</span>
          <h1 className="display h1" style={{ marginTop: 18 }}>
            Make v{next}.
          </h1>
          <p className="lede">Say in one sentence what {a.name} should do better. Fabrica changes only that, runs the full suite again with every attack, and v{next} goes live on the same page only if it passes.</p>
        </div>
      </section>
      <section className="section--tight build">
        <div className="wrap">
          <BuildFlow
            initialSentence={(sp.s ?? '').slice(0, 400)}
            initialDraft={draft}
            buildFee={cfg.buildFee}
            buildOpen={cfg.buildOpen && cfg.versionsOpen}
            closedReason={cfg.buildOpen ? closed : cfg.buildClosedReason}
            improve={{ slug: a.slug, name: a.name, tagline: a.tagline, maker: a.maker, version: a.version, next, price: a.price, tests: a.tests ? { taskPassed: a.tests.taskPassed, taskTotal: a.tests.taskTotal, safetyPassed: a.tests.safetyPassed, safetyTotal: a.tests.safetyTotal } : null, paidCalls: a.stats.paidCalls }}
          />
        </div>
      </section>
    </>
  );
}
