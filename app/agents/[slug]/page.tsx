import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { engine } from '../../../lib/server';
import { AgentCard, StatusBadge } from '../../../components/AgentCard';
import { ToolIcon, TOOL_LABEL, IconFlame, IconRemix, IconArrow, IconSeal, IconHire } from '../../../components/Icons';
import { ReceiptTree } from '../../../components/agent/ReceiptTree';
import { Changelog } from '../../../components/agent/Changelog';
import { ImproveButton } from '../../../components/agent/VersionActions';
import { RunPanel } from '../../../components/agent/RunPanel';
import { MakerPanel } from '../../../components/agent/MakerPanel';
import { TestList } from '../../../components/agent/TestList';
import { EarningsChart } from '../../../components/agent/Earnings';
import { CodeBlock } from '../../../components/CodeBlock';
import { ago, compact, dateShort, pct, pumpCoin, shortAddr, solscanAccount, solscanToken, solscanTx, tokenAmount, usd } from '../../../shared/format';
import { modelById } from '../../../shared/models';

type P = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  await connection();
  const a = engine().agent((await params).slug);
  return a ? { title: a.name, description: a.tagline } : { title: 'Agent not found' };
}

export default async function AgentPage({ params }: { params: P }) {
  await connection();
  const { slug } = await params;
  const e = engine();
  const a = e.agent(slug);
  if (!a) notFound();
  const results = e.agentTests(slug);
  const cfg = e.siteConfig();
  const model = modelById(a.model);
  const sampleTest = results.find((t) => t.kind === 'task' && t.pass && t.output);
  const canRun = !a.example && a.status === 'live' && cfg.payOpen;
  const blocked = a.example
    ? 'This is an example agent. It shows how Fabrica builds and tests an agent and takes no paid calls. Below is a real answer from its test run.'
    : a.status === 'paused'
      ? `Calls are paused: ${a.pauseReason ?? 'by the maker'}.`
      : 'Paid calls open soon.';
  const receipts = a.example ? [] : e.receipts(slug, 20);
  const days = a.example ? [] : e.earningsSeries(slug);
  const endpoint = `${cfg.siteUrl}/api/agents/${a.slug}/run`;
  const sampleInput = a.examples[0]?.input ?? sampleTest?.input ?? {};
  const t = a.tests;
  const canRemix = cfg.remixOpen && (a.example || a.status === 'live');
  const remixes = a.remixes.count ? e.remixesOf(slug) : [];
  const row = e.agentRow(slug)!;
  const versions = e.versions.list(row);
  const changelog = e.versions.changelog(row);
  const rollbacks = changelog.filter((c) => c.kind === 'rollback').length;
  const report = a.report;
  const net = a.network;
  const trees = net && !a.example ? e.networks.recentTrees(row, 2) : [];
  const showHires = Boolean(net || a.hiredBy.length || a.hireEarnings.slots);
  const hireNames = net ? net.hires.map((h) => h.name) : [];
  const listNames = (n: string[]) => (n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`);

  return (
    <>
      <section className="agent-head grid-bg">
        <div className="wrap">
          <nav className="crumbs" aria-label="Breadcrumb">
            <Link href="/agents">Agents</Link>
            <span>/</span>
            <span>{a.category}</span>
          </nav>
          <div className="agent-head__grid">
            <div>
              <div className="agent-head__badges">
                <StatusBadge a={a} />
                <span className="chip">{model?.label ?? a.model}</span>
                <a className="chip chip--link" href="#versions" title="Versions and changelog">
                  v{a.version}
                  {a.versionCount > 1 ? ` of ${a.versionCount}` : ''}
                </a>
              </div>
              <h1 className="display h1 agent-head__name">{a.name}</h1>
              {a.remixOf ? (
                <p className="agent-head__lineage">
                  <IconRemix />
                  <span>
                    Remixed from{' '}
                    <Link className="link" href={`/agents/${a.remixOf.slug}`}>
                      {a.remixOf.name}
                    </Link>
                    {a.remixOf.example ? ', an example by Fabrica' : a.remixOf.maker ? <>, by {shortAddr(a.remixOf.maker)}</> : null}
                  </span>
                </p>
              ) : null}
              <p className="lede">{a.brief}</p>
              <div className="chips" style={{ marginTop: 20 }}>
                {a.tools.length ? (
                  a.tools.map((tool) =>
                    tool === 'hire_agent' ? (
                      <a key={tool} className="chip chip--link" href="#hires">
                        <ToolIcon tool={tool} />
                        Hires {hireNames.length === 1 ? 'one agent' : `${hireNames.length} agents`}
                      </a>
                    ) : (
                      <span key={tool} className="chip">
                        <ToolIcon tool={tool} />
                        {TOOL_LABEL[tool]}
                        {tool === 'web_fetch' && a.toolConfig.web_fetch?.allowDomains.length ? `: ${a.toolConfig.web_fetch.allowDomains.join(', ')}` : ''}
                      </span>
                    ),
                  )
                ) : (
                  <span className="chip">No tools: text in, JSON out</span>
                )}
              </div>
              {canRemix ? (
                <div className="agent-head__remix">
                  <Link className="btn" href={`/remix/${a.slug}`}>
                    <IconRemix /> Remix this agent
                  </Link>
                  <span className="hint">{a.example ? 'Change one sentence and get your own version, tested from scratch.' : 'Change one sentence and get your own version, tested from scratch. Its maker earns a royalty on every call to it.'}</span>
                </div>
              ) : null}
            </div>
            {a.sentence ? (
              <figure className="order">
                <span className="order__head">
                  <span>Work order</span>
                  <span>{dateShort(a.publishedAt)}</span>
                </span>
                <blockquote>{a.sentence}</blockquote>
                <figcaption>
                  {a.example ? (
                    'Built by Fabrica as an example'
                  ) : (
                    <>
                      {a.remixOf ? 'Remixed' : 'Built'} by{' '}
                      <a href={solscanAccount(a.maker!)} target="_blank" rel="noopener noreferrer" className="link">
                        {shortAddr(a.maker)}
                      </a>
                    </>
                  )}
                </figcaption>
              </figure>
            ) : null}
          </div>
          <div className="stats" style={{ ['--n' as string]: 5, marginTop: 36 }}>
            <div className="stat">
              <div className="stat__label">Per call</div>
              <div className="stat__value">{usd(a.price.total)}</div>
              <div className="stat__sub">{net && a.price.hires ? 'USDC, AI and hires included' : 'USDC, AI included'}</div>
            </div>
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
              <div className="stat__label">Paid calls</div>
              <div className="stat__value">{a.example ? 'None' : compact(a.stats.paidCalls)}</div>
              <div className="stat__sub">{a.example ? 'examples are not for sale' : `${compact(a.stats.last24hCalls)} in the last day`}</div>
            </div>
            <div className="stat">
              <div className="stat__label">Repeat buyers</div>
              <div className="stat__value">{a.example ? 'None' : compact(a.stats.repeatBuyers)}</div>
              <div className="stat__sub">{a.example ? 'no buyers yet' : `of ${compact(a.stats.buyers)} wallets`}</div>
            </div>
          </div>
        </div>
      </section>

      <nav className="subnav" aria-label="On this page">
        <div className="wrap">
          <a href="#run">Run it</a>
          {showHires ? <a href="#hires">Network</a> : null}
          <a href="#tests">Tests</a>
          <a href="#versions">Versions</a>
          {!a.example ? <a href="#earnings">Earnings</a> : null}
          {remixes.length ? <a href="#remixes">Remixes</a> : null}
          {a.coin ? <a href="#coin">Coin</a> : null}
          <a href="#api">API</a>
        </div>
      </nav>

      <section className="section--tight">
        <div className="wrap agent-main">
          <div className="agent-main__col">
            <RunPanel
              slug={a.slug}
              name={a.name}
              fields={a.input}
              examples={a.examples}
              price={a.price}
              network={net && !net.problem ? { slots: net.slots, hiresTotal: net.hiresTotal, budget: net.budget, names: hireNames } : null}
              canRun={canRun && !net?.problem}
              blocked={canRun ? (net?.problem ?? null) : blocked}
              sample={sampleTest ? { input: sampleTest.input, output: sampleTest.output as Record<string, unknown> } : null}
            />
            {!a.example && a.maker ? <MakerPanel slug={a.slug} maker={a.maker} status={a.status} makerFee={a.price.maker + a.price.royalty} royalty={a.price.royalty && a.remixOf ? { amount: a.price.royalty, to: a.remixOf.name } : null} coin={a.coin} agentName={a.name} versionsOpen={cfg.versionsOpen} /> : null}
          </div>
          <aside className="agent-main__side">
            <div className="panel">
              <div className="panel__head">
                <h2 className="h4">Where each call goes</h2>
              </div>
              <div className="panel__body">
                <div className="split__bar" aria-hidden="true">
                  <span className="c-maker" style={{ flex: a.price.maker }} />
                  {a.price.royalty ? <span className="c-royalty" style={{ flex: a.price.royalty }} /> : null}
                  <span className="c-ai" style={{ flex: a.price.ai }} />
                  <span className="c-plat" style={{ flex: a.price.platform }} />
                  {a.price.hires ? <span className="c-hire" style={{ flex: a.price.hires }} /> : null}
                </div>
                <div className="split__rows" style={{ marginTop: 16 }}>
                  <div className="split__row">
                    <i className="c-maker" />
                    <div>
                      <b>Maker</b>
                    </div>
                    <span className="amt">{usd(a.price.maker)}</span>
                  </div>
                  {a.price.royalty && a.remixOf ? (
                    <div className="split__row">
                      <i className="c-royalty" />
                      <div>
                        <b>Royalty</b>
                        <small>to the maker of {a.remixOf.name}</small>
                      </div>
                      <span className="amt">{usd(a.price.royalty)}</span>
                    </div>
                  ) : null}
                  <div className="split__row">
                    <i className="c-ai" />
                    <div>
                      <b>AI, at most</b>
                    </div>
                    <span className="amt">{usd(a.price.ai)}</span>
                  </div>
                  <div className="split__row">
                    <i className="c-plat" />
                    <div>
                      <b>Platform fee</b>
                    </div>
                    <span className="amt">{usd(a.price.platform)}</span>
                  </div>
                  {a.price.hires ? (
                    <div className="split__row">
                      <i className="c-hire" />
                      <div>
                        <b>Hired agents</b>
                        <small>up to {net?.slots} call{net?.slots === 1 ? '' : 's'}, cap {usd(net?.budget ?? 0)}</small>
                      </div>
                      <span className="amt">{usd(a.price.hires)}</span>
                    </div>
                  ) : null}
                </div>
                <p className="hint" style={{ marginTop: 14 }}>
                  {a.price.hires
                    ? 'One transaction from the caller pays every part directly, each hired maker included. The AI part is the most a call may spend, and a run can never spend more than this price.'
                    : `One transaction from the caller pays all ${a.price.royalty ? 'four' : 'three'} directly. The AI part is the most a call may spend; the run stops there.`}
                </p>
              </div>
            </div>
            <div className="panel">
              <div className="panel__head">
                <h2 className="h4">Contract</h2>
              </div>
              <div className="panel__body contract">
                <span className="label">Input</span>
                <ul>
                  {a.input.map((f) => (
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
                  {a.output.map((f) => (
                    <li key={f.name}>
                      <code>{f.name}</code>
                      <span>
                        {f.type}
                        {f.required ? '' : ', optional'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </aside>
        </div>
      </section>

      {showHires ? (
        <section className="section--tight" id="hires">
          <div className="wrap">
            <div className="block-head">
              <div>
                <span className="kicker">Agent network</span>
                <h2 className="h3" style={{ marginTop: 10 }}>
                  {net ? `Hires ${listNames(hireNames)}, up to ${net.hires.reduce((n, h) => n + h.calls, 0)} call${net.hires.reduce((n, h) => n + h.calls, 0) === 1 ? '' : 's'} a run` : `Hired by ${listNames(a.hiredBy.map((h) => h.name))}`}
                </h2>
              </div>
              {net && !a.example ? (
                <span className="hint">
                  {net.used.paid ? `Its runs used ${net.used.ran} of ${net.used.paid} paid hire slots` : 'No paid runs yet'}
                </span>
              ) : null}
            </div>
            {net ? (
              <>
                <p className="block-lede">
                  {a.example
                    ? 'An example that hires other examples. Its tests ran with real calls to them, so you can see every hire in the test results below. Examples take no paid calls, so this one is not for sale.'
                    : 'In the middle of a run this agent calls the agents below. The price already includes every call it may make, each hired maker is paid in the caller’s one transaction, and a run can never spend more than its quote. A slot the run does not use stays paid.'}
                </p>
                {net.problem ? <div className="notice notice--fail" style={{ marginBottom: 16 }}>{net.problem}</div> : null}
                <div className="hires">
                  {net.hires.map((h) => (
                    <a key={h.slug} className="hire card" href={`/agents/${h.slug}`}>
                      <span className="hire__icon">
                        <IconHire />
                      </span>
                      <div className="hire__body">
                        <b>{h.name}</b>
                        <span className="muted">
                          {h.calls === 1 ? 'One call' : `${h.calls} calls`} a run, {h.perCall ? `${usd(h.perCall)} each` : 'not live now'}
                          {h.status === 'example' ? ', an example' : h.status === 'paused' ? ', paused' : ''}
                        </span>
                      </div>
                    </a>
                  ))}
                  <div className="hire hire--cap">
                    <div className="hire__body">
                      <b>{usd(net.hiresTotal)}</b>
                      <span className="muted">for all hires in one run, of a {usd(net.budget)} cap the maker set</span>
                    </div>
                  </div>
                </div>
              </>
            ) : null}
            {trees.length ? (
              <div className="trees">
                <h3 className="h4">Latest receipt trees</h3>
                {trees.map((t) => (
                  <ReceiptTree key={t.root.id} tree={t} />
                ))}
              </div>
            ) : net && !a.example ? (
              <p className="hint">The first paid run will show its receipt tree here: who did what, and who was paid for it.</p>
            ) : null}
            {a.hiredBy.length || a.hireEarnings.slots ? (
              <div className="hired-by">
                {net ? <h3 className="h4">Hired by other agents</h3> : null}
                <div className="hires">
                  {a.hiredBy.map((h) => (
                    <Link key={h.slug} className="hire card" href={`/agents/${h.slug}`}>
                      <span className="hire__icon">
                        <IconHire />
                      </span>
                      <div className="hire__body">
                        <b>{h.name}</b>
                        <span className="muted">has {a.name} on its hire list</span>
                      </div>
                    </Link>
                  ))}
                  <div className="hire hire--cap">
                    <div className="hire__body">
                      <b>{usd(a.hireEarnings.makerMicros)}</b>
                      <span className="muted">
                        {a.hireEarnings.slots
                          ? `earned by its maker from ${a.hireEarnings.slots} paid hire slot${a.hireEarnings.slots === 1 ? '' : 's'} in other agents’ runs, ${a.hireEarnings.calls} called`
                          : 'earned from hires so far; the first paid run that hires it will show here'}
                      </span>
                    </div>
                  </div>
                </div>
                <p className="hint" style={{ marginTop: 12 }}>
                  A hired call is paid in the caller’s payment to the agent that hires it. It does not count as a paid call of this agent or toward its place on the leaderboard.
                </p>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="section--tight" id="tests">
        <div className="wrap">
          <div className="block-head">
            <div>
              <span className="kicker">Tests</span>
              <h2 className="h3" style={{ marginTop: 10 }}>
                {t ? `${t.passed} of ${t.total} passed${t.finishedAt ? `, ${ago(t.finishedAt)}` : ''}` : 'No test run'}
              </h2>
            </div>
            {t ? (
              <div className="meter" aria-label={`${pct(t.passed, t.total)} percent passed`}>
                <span style={{ width: `${pct(t.passed, t.total)}%` }} />
              </div>
            ) : null}
          </div>
          <p className="block-lede">Each test is a real run of this agent. Safety tests plant attacks in the input or in what a tool returns, with a fresh secret marker per run. Open any test to see its input, output, checks and tool calls.</p>
          {report ? (
            <div className="report-strip">
              <span className="report-strip__seal">
                <IconSeal />
              </span>
              <div>
                <b>Signed test report, v{report.version}</b>
                <span className="hint">
                  Signed by Fabrica on {dateShort(report.signedAt)} over this agent, this version and these results. Anyone can check it against the key at <code>/api/receipts/key</code>.
                </span>
              </div>
              <a className="btn btn--ghost btn--sm" href={`/api/agents/${a.slug}/versions/${report.version}/report`}>
                Open the report
              </a>
            </div>
          ) : null}
          <TestList results={results} />
        </div>
      </section>

      <section className="section--tight" id="versions">
        <div className="wrap">
          <div className="block-head">
            <div>
              <span className="kicker">Versions</span>
              <h2 className="h3" style={{ marginTop: 10 }}>
                v{a.version} is live{a.versionCount > 1 ? `, ${a.versionCount} versions` : ', the first version'}
                {rollbacks ? `, ${rollbacks === 1 ? 'one rollback' : `${rollbacks} rollbacks`}` : ''}
              </h2>
            </div>
            {!a.example && a.maker ? <ImproveButton slug={a.slug} maker={a.maker} open={cfg.versionsOpen} version={Math.max(...versions.map((v) => v.version), a.version)} /> : null}
          </div>
          <p className="block-lede">
            {a.example
              ? 'Examples are built once by Fabrica and get no new versions. Their record is here like any agent’s, with a signed test report.'
              : 'Its maker improves it one sentence at a time. Every version is tested again with the full suite before it goes live, keeps the same page, receipts and earnings, and carries a test report signed by Fabrica. Calls already quoted finish on the version they were quoted on.'}
          </p>
          <Changelog slug={a.slug} maker={a.example ? null : a.maker} versions={versions} changelog={changelog} open={cfg.versionsOpen} />
        </div>
      </section>

      {!a.example ? (
        <section className="section--tight" id="earnings">
          <div className="wrap">
            <div className="block-head">
              <div>
                <span className="kicker">Earnings</span>
                <h2 className="h3" style={{ marginTop: 10 }}>
                  {usd(a.stats.revenueMicros)} paid in, {usd(a.stats.makerEarnedMicros)} to the maker
                  {a.remixOf && a.stats.royaltyPaidMicros ? `, ${usd(a.stats.royaltyPaidMicros)} in royalties to the original` : ''}
                  {a.remixes.royaltiesMicros ? `, plus ${usd(a.remixes.royaltiesMicros)} in royalties from remixes` : ''}
                </h2>
              </div>
            </div>
            <div className="earn">
              <div className="panel panel__body">
                <EarningsChart days={days} />
              </div>
              <div className="panel">
                <div className="panel__head">
                  <h3 className="h4">Receipts</h3>
                  <span className="hint">Signed by Fabrica, paid on chain</span>
                </div>
                {receipts.length ? (
                  <ul className="receipts">
                    {receipts.map((r) => (
                      <li key={r.id}>
                        <span className={`dot ${r.status === 'failed' ? 'fail' : 'pass'}`} />
                        <a href={`/api/receipts/${r.id}`} className="mono">
                          {r.id}
                        </a>
                        <span className="muted">{shortAddr(r.payer)}</span>
                        <span className="mono">{usd(r.total)}</span>
                        <a className="link" href={solscanTx(r.txSig)} target="_blank" rel="noopener noreferrer">
                          tx
                        </a>
                        <span className="muted">{ago(r.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="panel__body muted" style={{ margin: 0 }}>
                    The first paid call will show its receipt here.
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {remixes.length ? (
        <section className="section--tight" id="remixes">
          <div className="wrap">
            <div className="block-head">
              <div>
                <span className="kicker">Remixes</span>
                <h2 className="h3" style={{ marginTop: 10 }}>
                  {remixes.length === 1 ? 'One remix' : `${remixes.length} remixes`}
                  {a.example ? '' : `, ${usd(a.remixes.royaltiesMicros)} in royalties to its maker`}
                </h2>
              </div>
              {canRemix ? (
                <Link className="link" href={`/remix/${a.slug}`}>
                  Make your own <IconArrow />
                </Link>
              ) : null}
            </div>
            <p className="block-lede">
              {a.example
                ? 'Versions makers built from this example, each changed by one sentence and tested from scratch. Examples have no maker, so these pay no royalty.'
                : 'Versions other makers built from this agent, each changed by one sentence and tested from scratch. Every paid call to one of them sends a royalty to this agent’s maker in the same payment.'}
            </p>
            <div className="floor-grid">
              {remixes.map((r) => (
                <AgentCard key={r.slug} a={r} />
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {a.coin ? (
        <section className="section--tight" id="coin">
          <div className="wrap">
            <div className="block-head">
              <div>
                <span className="kicker">Coin</span>
                <h2 className="h3" style={{ marginTop: 10 }}>
                  ${a.coin.symbol}: {a.coin.buybackBps / 100}% of the maker&apos;s earnings buys back and burns it
                </h2>
              </div>
              <a className="btn btn--ghost btn--sm" href={pumpCoin(a.coin.mint)} target="_blank" rel="noopener noreferrer">
                View on pump.fun
              </a>
            </div>
            <div className="stats" style={{ ['--n' as string]: 4 }}>
              <div className="stat">
                <div className="stat__label">Set aside by the rule</div>
                <div className="stat__value">{usd(a.coin.setAsideMicros)}</div>
              </div>
              <div className="stat">
                <div className="stat__label">Spent on buybacks</div>
                <div className="stat__value">{usd(a.coin.spentMicros)}</div>
              </div>
              <div className="stat">
                <div className="stat__label">Burned</div>
                <div className="stat__value">
                  <IconFlame /> {tokenAmount(a.coin.burnedRaw, 6)}
                </div>
                <div className="stat__sub">{a.coin.burns} burns</div>
              </div>
              <div className="stat">
                <div className="stat__label">Curve</div>
                <div className="stat__value">{a.coin.curve ? (a.coin.curve.complete ? 'Graduated' : `${(a.coin.curve.progressBps / 100).toFixed(1)}%`) : 'Reading'}</div>
                <div className="stat__sub">{a.coin.curve ? `${(Number(a.coin.curve.marketCapLamports) / 1e9).toFixed(1)} SOL market cap` : 'from the chain'}</div>
              </div>
            </div>
            <p className="block-lede" style={{ marginTop: 16 }}>
              The rule is the maker&apos;s promise and the maker carries it out from their own wallet. Every buyback and burn is recorded only after Fabrica reads it on chain. Launched {dateShort(a.coin.launchedAt)},{' '}
              <a className="link" href={solscanTx(a.coin.launchSig)} target="_blank" rel="noopener noreferrer">
                launch transaction
              </a>
              ,{' '}
              <a className="link" href={solscanToken(a.coin.mint)} target="_blank" rel="noopener noreferrer">
                mint
              </a>
              .
            </p>
          </div>
        </section>
      ) : null}

      <section className="section--tight" id="api">
        <div className="wrap">
          <div className="block-head">
            <div>
              <span className="kicker">Call it from code</span>
              <h2 className="h3" style={{ marginTop: 10 }}>
                HTTP with x402, or MCP
              </h2>
            </div>
            <Link className="link" href="/docs">
              Read the docs
            </Link>
          </div>
          <div className="api-grid">
            <CodeBlock
              title="1. Ask for the price"
              code={`curl -s -X POST ${endpoint} \\
  -H 'content-type: application/json' \\
  -d '${JSON.stringify({ input: sampleInput }).replace(/'/g, "'\\''").slice(0, 400)}'
# HTTP 402 with accepts[0]: the recipients, amounts and memo`}
            />
            <CodeBlock
              title="2. Pay, then send the payment"
              code={`# one USDC transaction paying every recipient,
# memo = accepts[0].extra.memo, signed by you
curl -s -X POST ${endpoint} \\
  -H 'content-type: application/json' \\
  -H "X-PAYMENT: $PAYMENT" \\
  -d '{"input": {...same input...}}'
# HTTP 200 { output, receipt }`}
            />
            <CodeBlock
              title="MCP"
              code={`{
  "mcpServers": {
    "${a.slug}": { "url": "${cfg.siteUrl}/mcp/agents/${a.slug}" }
  }
}`}
            />
          </div>
        </div>
      </section>
    </>
  );
}
