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
  return a ? { title: `Remix ${a.name}`, description: `Change one sentence of ${a.name} and get your own version, tested from scratch.` } : { title: 'Agent not found' };
}

export default async function RemixPage({ params, searchParams }: { params: P; searchParams: SP }) {
  await connection();
  const { slug } = await params;
  const sp = await searchParams;
  const e = engine();
  const a = e.agent(slug);
  if (!a) notFound();
  const cfg = e.siteConfig();
  const draft = sp.draft && /^d_[A-Za-z0-9_-]{8,20}$/.test(sp.draft) ? sp.draft : null;
  // A remix in progress always opens, so a paid draft can be finished even while new remixes are switched off.
  const open = cfg.remixOpen && (a.example || a.status === 'live');
  const closed = !cfg.remixOpen ? 'Remixing is paused for now. Remixes already live keep working.' : a.status === 'paused' ? 'This agent is paused, so it can not be remixed right now.' : null;
  return (
    <>
      <section className="page-head grid-bg">
        <div className="wrap">
          <span className="kicker">Remix</span>
          <h1 className="display h1" style={{ marginTop: 18 }}>
            Make it yours.
          </h1>
          <p className="lede">Change one sentence of {a.name}. Fabrica rewrites only that part, tests your version from scratch, and it goes live only if it passes.</p>
        </div>
      </section>
      <section className="section--tight build">
        <div className="wrap">
          <BuildFlow
            initialSentence={(sp.s ?? '').slice(0, 400)}
            initialDraft={draft}
            buildFee={cfg.buildFee}
            buildOpen={cfg.buildOpen && open}
            closedReason={cfg.buildOpen ? closed : cfg.buildClosedReason}
            remix={{ slug: a.slug, name: a.name, tagline: a.tagline, maker: a.maker, example: a.example, makerFee: a.price.maker + a.price.royalty, price: a.price, tests: a.tests ? { passed: a.tests.passed, total: a.tests.total } : null }}
          />
        </div>
      </section>
    </>
  );
}
