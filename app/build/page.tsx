import type { Metadata } from 'next';
import { connection } from 'next/server';
import { engine } from '../../lib/server';
import { BuildFlow } from '../../components/build/BuildFlow';

export const metadata: Metadata = { title: 'Build an agent', description: 'Describe an agent in one sentence. Fabrica writes the spec, tests it and opens it for paid calls.' };

type SP = Promise<{ s?: string; draft?: string }>;

export default async function BuildPage({ searchParams }: { searchParams: SP }) {
  await connection();
  const sp = await searchParams;
  const cfg = engine().siteConfig();
  const draft = sp.draft && /^d_[A-Za-z0-9_-]{8,20}$/.test(sp.draft) ? sp.draft : null;
  return (
    <>
      <section className="page-head grid-bg">
        <div className="wrap">
          <span className="kicker">The workshop</span>
          <h1 className="display h1" style={{ marginTop: 18 }}>
            Build an agent.
          </h1>
          <p className="lede">Say what it should do. Fabrica drafts every part, you review and edit it, the tests decide whether it ships, and buyers pay you per call.</p>
        </div>
      </section>
      <section className="section--tight build">
        <div className="wrap">
          <BuildFlow initialSentence={(sp.s ?? '').slice(0, 400)} initialDraft={draft} buildFee={cfg.buildFee} buildOpen={cfg.buildOpen} closedReason={cfg.buildClosedReason} />
        </div>
      </section>
    </>
  );
}
