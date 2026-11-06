import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { engine } from '../../../../../lib/server';
import { TestList } from '../../../../../components/agent/TestList';
import { ChangeList } from '../../../../../components/agent/Changelog';
import { RollbackButton } from '../../../../../components/agent/VersionActions';
import { IconArrow, IconSeal, ToolIcon, TOOL_LABEL } from '../../../../../components/Icons';
import { dateShort, shortAddr } from '../../../../../shared/format';
import { modelById } from '../../../../../shared/models';
import type { AgentSpec, ToolName } from '../../../../../shared/types';

type P = Promise<{ slug: string; n: string }>;

function load(slug: string, n: string) {
  const e = engine();
  const a = e.agent(slug);
  const num = /^\d{1,4}$/.test(n) ? Number(n) : NaN;
  if (!a || !Number.isFinite(num)) return null;
  const row = e.agentRow(slug)!;
  const v = e.versions.row(row.id, num);
  if (!v) return null;
  return { e, a, row, v, pub: e.versions.publicOf(row, v), spec: JSON.parse(v.spec) as AgentSpec, report: e.versions.report(row, num), results: e.versions.results(row, num) };
}

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  await connection();
  const { slug, n } = await params;
  const x = load(slug, n);
  return x ? { title: `${x.spec.name}, v${x.v.version}`, description: `Version ${x.v.version} of ${x.a.name}: what changed, its tests and its signed test report.` } : { title: 'Version not found' };
}

export default async function VersionPage({ params }: { params: P }) {
  await connection();
  const { slug, n } = await params;
  const x = load(slug, n);
  if (!x) notFound();
  const { e, a, pub, spec, report, results } = x;
  const t = pub.tests;
  const cfg = e.siteConfig();
  const model = modelById(spec.model);
  return (
    <>
      <section className="agent-head grid-bg">
        <div className="wrap">
          <nav className="crumbs" aria-label="Breadcrumb">
            <Link href="/agents">Agents</Link>
            <span>/</span>
            <Link href={`/agents/${a.slug}`}>{a.name}</Link>
            <span>/</span>
            <span>v{pub.version}</span>
          </nav>
          <div className="agent-head__badges">
            {pub.live ? <span className="badge badge--live">Live</span> : <span className="badge badge--earlier">Earlier version</span>}
            <span className="chip">{model?.label ?? spec.model}</span>
            <span className="chip">{dateShort(pub.createdAt)}</span>
          </div>
          <h1 className="display h1 agent-head__name">
            {spec.name} <span className="vpage__num">v{pub.version}</span>
          </h1>
          <p className="lede">{spec.brief}</p>
          <div className="vpage__note">
            {pub.live ? (
              <span>{a.example ? 'This is the live version. Examples take no paid calls.' : 'This is the live version. Paid calls run it now.'}</span>
            ) : (
              <span>
                Read only. v{a.version} is live; this version takes no calls unless its maker makes it live again.{' '}
              </span>
            )}
            <Link className="link" href={`/agents/${a.slug}#versions`}>
              All versions <IconArrow />
            </Link>
          </div>
          {!pub.live && a.maker && !a.example && t?.publishable ? <RollbackButton slug={a.slug} maker={a.maker} version={pub.version} open={cfg.versionsOpen} /> : null}
          <div className="stats" style={{ ['--n' as string]: 4, marginTop: 32 }}>
            <div className="stat">
              <div className="stat__label">Task tests</div>
              <div className="stat__value">{t ? `${t.taskPassed}/${t.taskTotal}` : 'None'}</div>
              <div className="stat__sub">{t ? `${t.score}% pass rate` : 'Not tested'}</div>
            </div>
            <div className="stat">
              <div className="stat__label">Safety tests</div>
              <div className="stat__value">{t ? `${t.safetyPassed}/${t.safetyTotal}` : 'None'}</div>
              <div className="stat__sub">attacks it resisted</div>
            </div>
            <div className="stat">
              <div className="stat__label">Made by</div>
              <div className="stat__value stat__value--sm">{a.example ? 'Fabrica' : shortAddr(a.maker)}</div>
              <div className="stat__sub">{pub.kind === 'improve' ? 'improved by its maker' : pub.kind === 'remix' ? 'remixed' : pub.kind === 'example' ? 'an example' : 'its maker'}</div>
            </div>
            <div className="stat">
              <div className="stat__label">Tools</div>
              <div className="stat__value stat__value--sm">{Object.keys(spec.tools).length || 'None'}</div>
              <div className="stat__sub">{(Object.keys(spec.tools) as ToolName[]).map((k) => TOOL_LABEL[k]).join(', ') || 'text in, JSON out'}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="section--tight">
        <div className="wrap vpage">
          <div className="vpage__main">
            {pub.sentence || pub.summary || pub.changes.length ? (
              <div className="panel">
                <div className="panel__head">
                  <h2 className="h4">{pub.version === 1 || !pub.changes.length ? 'How it was made' : `What changed from v${pub.baseVersion ?? pub.version - 1}`}</h2>
                </div>
                <div className="panel__body vpage__made">
                  {pub.sentence ? <blockquote className="vlog__sentence">{pub.sentence}</blockquote> : null}
                  {pub.summary ? <p className="vlog__summary">{pub.summary}</p> : null}
                  <ChangeList changes={pub.changes} />
                </div>
              </div>
            ) : null}
            <div className="block-head" style={{ marginTop: 36 }}>
              <div>
                <span className="kicker">Tests of v{pub.version}</span>
                <h2 className="h3" style={{ marginTop: 10 }}>
                  {t ? `${t.passed} of ${t.total} passed` : 'No test run'}
                </h2>
              </div>
            </div>
            <TestList results={results} />
          </div>
          <aside className="agent-main__side">
            {report ? (
              <div className="panel">
                <div className="panel__head">
                  <h2 className="h4">Signed test report</h2>
                  <IconSeal />
                </div>
                <div className="panel__body vpage__report">
                  <dl>
                    <dt>Format</dt>
                    <dd>{report.format}</dd>
                    <dt>Results hash</dt>
                    <dd>{report.resultsHash.slice(0, 16)}...</dd>
                    <dt>Spec hash</dt>
                    <dd>{report.specHash.slice(0, 16)}...</dd>
                    <dt>Signature</dt>
                    <dd>{report.signature.slice(0, 16)}...</dd>
                    <dt>Signed</dt>
                    <dd>{dateShort(report.signedAt)}</dd>
                  </dl>
                  <a className="btn btn--ghost btn--sm" href={`/api/agents/${a.slug}/versions/${pub.version}/report`}>
                    Open the report
                  </a>
                  <p className="hint">Rebuild the message from the report, then check the ed25519 signature against the key at /api/receipts/key.</p>
                </div>
              </div>
            ) : null}
            <div className="panel">
              <div className="panel__head">
                <h2 className="h4">Contract of v{pub.version}</h2>
              </div>
              <div className="panel__body contract">
                <span className="label">Input</span>
                <ul>
                  {spec.input.map((f) => (
                    <li key={f.name}>
                      <code>{f.name}</code>
                      <span>
                        {f.type}
                        {f.required ? '' : ', optional'}
                      </span>
                    </li>
                  ))}
                </ul>
                <span className="label">Output</span>
                <ul>
                  {spec.output.map((f) => (
                    <li key={f.name}>
                      <code>{f.name}</code>
                      <span>
                        {f.type}
                        {f.required ? '' : ', optional'}
                      </span>
                    </li>
                  ))}
                </ul>
                {Object.keys(spec.tools).length ? (
                  <div className="chips" style={{ marginTop: 14 }}>
                    {(Object.keys(spec.tools) as ToolName[]).map((tool) => (
                      <span key={tool} className="chip">
                        <ToolIcon tool={tool} />
                        {TOOL_LABEL[tool]}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </aside>
        </div>
      </section>
    </>
  );
}
