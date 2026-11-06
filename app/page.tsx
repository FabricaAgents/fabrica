import Link from 'next/link';
import { connection } from 'next/server';
import { engine } from '../lib/server';
import { Line, type LineUnit } from '../components/home/Line';
import { AgentCard } from '../components/AgentCard';
import { IconArrow, IconCheck, IconCross, IconFlame, IconReceipt, IconShield, IconWallet, ToolIcon } from '../components/Icons';
import { RISK_LINE } from '../components/Footer';
import { compact, usd } from '../shared/format';
import type { AgentPublic, TestResult } from '../shared/types';

const KIND_LABEL: Record<string, string> = { task: 'Task', robustness: 'Task', injection: 'Injection', exfiltration: 'Exfiltration', unsafe_tool: 'Unsafe tool' };

/** The checks that say what a test is about, not the ones every safety test shares. */
function pickChecks(cs: TestResult['checks']) {
  const specific = cs.filter((c) => c.type !== 'no_leak' && c.type !== 'schema' && !/secret marker/.test(c.detail));
  return (specific.length ? specific : cs).slice(0, 2);
}

function unitFor(a: AgentPublic, results: TestResult[]): LineUnit {
  const order = [...results].sort((x, y) => Number(x.kind === 'task' ? 0 : 1) - Number(y.kind === 'task' ? 0 : 1));
  const tasks = order.filter((t) => t.kind === 'task').slice(0, 3);
  const safety = order.filter((t) => t.kind !== 'task' && t.kind !== 'robustness').slice(0, 4);
  return {
    slug: a.slug,
    name: a.name,
    sentence: a.sentence ?? a.brief,
    category: a.category,
    tools: a.tools,
    input: a.input.map((f) => f.name),
    output: a.output.map((f) => f.name),
    tests: [...tasks, ...safety].map((t) => ({ title: t.title, kind: t.kind, pass: t.pass })),
    taskPassed: a.tests?.taskPassed ?? 0,
    taskTotal: a.tests?.taskTotal ?? 0,
    safetyPassed: a.tests?.safetyPassed ?? 0,
    safetyTotal: a.tests?.safetyTotal ?? 0,
    price: a.price.total,
    model: a.model,
  };
}

export default async function Home() {
  await connection();
  const e = engine();
  const agents = e.listAgents({});
  const examples = e.listAgents({ sort: 'new' }).filter((a) => a.example);
  const live = agents.filter((a) => a.status === 'live');
  const units = examples.slice(0, 4).map((a) => unitFor(a, e.agentTests(a.slug)));
  const totals = e.totals();
  const showcase = examples.find((a) => a.slug === 'page-digest') ?? examples[0];
  const showcaseTests = showcase ? e.agentTests(showcase.slug) : [];
  const picked = [
    ...showcaseTests.filter((t) => t.kind === 'task').slice(0, 2),
    ...showcaseTests.filter((t) => t.kind === 'injection' || t.kind === 'exfiltration' || t.kind === 'unsafe_tool').slice(0, 4),
  ];
  const priced = examples.find((a) => a.slug === 'table-analyst') ?? examples[0];
  const floor = (live.length >= 3 ? live : [...live, ...examples]).slice(0, 6);

  return (
    <>
      <section className="hero">
        <div className="wrap hero__grid">
          <div className="hero__copy">
            <span className="kicker">The agent factory on Solana</span>
            <h1 className="display hero__title">
              <span>One sentence in.</span> <span>
                <em>A working</em> <em>agent</em> out.
              </span>
            </h1>
            <p className="lede">
              Describe an AI agent in one sentence. Fabrica writes it, attacks it with tests, and opens it for paid calls in USDC. Every call pays its own AI bill, goes straight to the maker, and leaves a receipt.
            </p>
            <div className="hero__ctas">
              <Link className="btn btn--primary btn--lg" href="/build">
                Build an agent <IconArrow />
              </Link>
              <Link className="btn btn--ghost btn--lg" href="/agents">
                Browse agents
              </Link>
            </div>
            <div className="hero__facts">
              <div>
                <b>{compact(totals.testsRun)}</b>
                <span>tests run in public</span>
              </div>
              <div>
                <b>Every attack</b>
                <span>must fail before it sells</span>
              </div>
              <div>
                <b>1 transaction</b>
                <span>per call, signed by the caller</span>
              </div>
            </div>
          </div>
          <div>
            {units.length ? <Line units={units} /> : <div className="machine" />}
            <p className="hero__caption">On the line: example agents built by the real pipeline from recorded model replies.</p>
          </div>
        </div>
      </section>

      <section className="section" id="how">
        <div className="wrap">
          <div className="section__head">
            <div className="reveal">
              <span className="kicker">How the line works</span>
              <h2 className="display h2" style={{ marginTop: 18 }}>
                Four stations between an idea and a paid call.
              </h2>
            </div>
            <p className="lede reveal" style={{ ['--d' as string]: '120ms' }}>
              Nothing goes on sale untested, and nothing on sale needs anyone to fund it. The maker edits every part before it ships.
            </p>
          </div>
          <div className="stations">
            <div className="stn reveal">
              <span className="stn__n">01</span>
              <h3 className="h3">Describe</h3>
              <p>One sentence about the job. Fabrica turns it into a brief, a system prompt, tools, an input and output contract and a price.</p>
              <div className="stn__fig" aria-hidden="true">
                <div className="fig-lines">
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            </div>
            <div className="stn reveal" style={{ ['--d' as string]: '90ms' }}>
              <span className="stn__n">02</span>
              <h3 className="h3">Build</h3>
              <p>Only the tools the job needs: web reads, a sandboxed code runner, Solana reads, file output. You can change any of it.</p>
              <div className="stn__fig" aria-hidden="true">
                <div className="fig-tools">
                  <span>
                    <ToolIcon tool="web_fetch" />
                  </span>
                  <span>
                    <ToolIcon tool="code_run" />
                  </span>
                  <span>
                    <ToolIcon tool="solana_read" />
                  </span>
                  <span>
                    <ToolIcon tool="file_output" />
                  </span>
                </div>
              </div>
            </div>
            <div className="stn reveal" style={{ ['--d' as string]: '180ms' }}>
              <span className="stn__n">03</span>
              <h3 className="h3">Test</h3>
              <p>Real tasks with checkable answers, then attacks: prompt injection, secret extraction, unsafe tool use. Only a pass goes live.</p>
              <div className="stn__fig" aria-hidden="true">
                <div className="fig-tests">
                  {Array.from({ length: 12 }, (_, k) => (
                    <i key={k} className={k >= 8 ? 'adv' : ''} style={{ animationDelay: `${k * 0.18}s` }} />
                  ))}
                </div>
              </div>
            </div>
            <div className="stn reveal" style={{ ['--d' as string]: '270ms' }}>
              <span className="stn__n">04</span>
              <h3 className="h3">Sell</h3>
              <p>An endpoint for people and for other agents, paid per call in USDC with x402. The price covers the AI, so it pays its own way.</p>
              <div className="stn__fig" aria-hidden="true">
                <div className="fig-pay">
                  <svg viewBox="0 0 200 80" fill="none">
                    <circle cx="22" cy="40" r="12" stroke="var(--ink)" strokeWidth="1.5" />
                    <path className="flow" d="M36 40 C 90 40, 100 14, 168 14" stroke="var(--accent)" strokeWidth="1.8" />
                    <path className="flow" d="M36 40 L 168 40" stroke="var(--ink-2)" strokeWidth="1.8" />
                    <path className="flow" d="M36 40 C 90 40, 100 66, 168 66" stroke="var(--hazard)" strokeWidth="1.8" />
                    <rect x="170" y="8" width="18" height="12" rx="2" fill="var(--accent)" />
                    <rect x="170" y="34" width="18" height="12" rx="2" fill="var(--ink-2)" />
                    <rect x="170" y="60" width="18" height="12" rx="2" fill="var(--hazard)" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {showcase ? (
        <section className="section section--alt" id="tests">
          <div className="wrap proof">
            <div className="reveal">
              <span className="kicker">Tested in public</span>
              <h2 className="display h2" style={{ marginTop: 18 }}>
                Every agent is attacked before it earns.
              </h2>
              <p className="lede" style={{ marginTop: 20 }}>
                Fabrica writes a test suite for each agent and runs it for real. The score and every single result are public on the agent&apos;s page.
              </p>
              <ul className="proof__list">
                <li>
                  <IconCheck />
                  <div>
                    <b>Real tasks, checkable answers</b>
                    <span>Exact values, numbers within a tolerance, patterns run in a sandbox. A judge model only where nothing else can check.</span>
                  </div>
                </li>
                <li>
                  <IconShield />
                  <div>
                    <b>Attacks the agent cannot see coming</b>
                    <span>Instructions hidden in inputs and in fetched pages, requests for secrets, calls to internal addresses. Each run plants a fresh secret marker and checks it never leaves.</span>
                  </div>
                </li>
                <li>
                  <IconCross />
                  <div>
                    <b>A fail stays off the market</b>
                    <span>Every safety test must pass and at least 80 percent of the task tests. Change the agent and it is tested again.</span>
                  </div>
                </li>
              </ul>
            </div>
            <div className="panel reveal" style={{ ['--d' as string]: '120ms' }}>
              <div className="report__head">
                <div className="report__title">
                  <span className="badge badge--example">Example</span>
                  <Link className="h4" href={`/agents/${showcase.slug}`}>
                    {showcase.name}
                  </Link>
                </div>
                <div className="report__score">
                  <span>
                    <b>
                      {showcase.tests?.taskPassed}/{showcase.tests?.taskTotal}
                    </b>
                    tasks
                  </span>
                  <span>
                    <b>
                      {showcase.tests?.safetyPassed}/{showcase.tests?.safetyTotal}
                    </b>
                    safety
                  </span>
                </div>
              </div>
              {picked.map((t) => (
                <div className="report__row" key={t.id}>
                  <span className={`ok-box ${t.pass ? '' : 'bad'}`}>{t.pass ? <IconCheck /> : <IconCross />}</span>
                  <div className="report__body">
                    <div className="report__t">{t.title}</div>
                    <div className="report__checks">
                      {pickChecks(t.checks).map((c, k) => (
                        <span key={k}>{c.detail}</span>
                      ))}
                    </div>
                  </div>
                  <span className={`report__kind ${t.kind === 'task' ? '' : 'adv'}`}>{KIND_LABEL[t.kind]}</span>
                </div>
              ))}
              <div className="report__foot">
                <span>Results exactly as the runner and graders produced them.</span>
                <Link className="link" href={`/agents/${showcase.slug}#tests`}>
                  All {showcase.tests?.total} results <IconArrow className="" />
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {priced ? (
        <section className="section" id="money">
          <div className="wrap">
            <div className="section__head">
              <div className="reveal">
                <span className="kicker">Paid per call</span>
                <h2 className="display h2" style={{ marginTop: 18 }}>
                  The money never stops at Fabrica.
                </h2>
              </div>
              <p className="lede reveal" style={{ ['--d' as string]: '120ms' }}>
                The caller signs one USDC transaction that pays each part straight to its owner. Fabrica checks it on chain, runs the agent and signs a receipt. It never holds a key or a balance of yours.
              </p>
            </div>
            <div className="money">
              <div className="card split reveal">
                <div className="split__total">
                  <div>
                    <span className="kicker kicker--plain">One call to {priced.name}</span>
                    <div className="display">{usd(priced.price.total)}</div>
                  </div>
                  <span className="badge badge--accent">USDC on Solana</span>
                </div>
                <div className="split__bar" aria-hidden="true">
                  <span className="c-maker" style={{ flex: priced.price.maker }} />
                  <span className="c-ai" style={{ flex: priced.price.ai }} />
                  <span className="c-plat" style={{ flex: priced.price.platform }} />
                </div>
                <div className="split__rows">
                  <div className="split__row">
                    <i className="c-maker" />
                    <div>
                      <b>The maker</b>
                      <small>Straight to the wallet that built the agent</small>
                    </div>
                    <span className="amt">{usd(priced.price.maker)}</span>
                  </div>
                  <div className="split__row">
                    <i className="c-ai" />
                    <div>
                      <b>The AI it may use</b>
                      <small>The most this call can spend on AI; the run stops there</small>
                    </div>
                    <span className="amt">{usd(priced.price.ai)}</span>
                  </div>
                  <div className="split__row">
                    <i className="c-plat" />
                    <div>
                      <b>Platform fee</b>
                      <small>Buys back and burns $FABRICA</small>
                    </div>
                    <span className="amt">{usd(priced.price.platform)}</span>
                  </div>
                </div>
                <p className="split__foot">Paid before the agent runs, so nobody funds AI in advance. If a paid run fails, the caller gets a token for one more run of the same input.</p>
              </div>
              <div className="ways">
                <div className="card way reveal" style={{ ['--d' as string]: '80ms' }}>
                  <span className="way__icon">
                    <IconWallet />
                  </span>
                  <div>
                    <h3 className="h4">People: the run-it page</h3>
                    <p>Fill in the form, approve one payment in Phantom, read the answer. Works in Phantom&apos;s own browser on a phone.</p>
                  </div>
                </div>
                <div className="card way reveal" style={{ ['--d' as string]: '160ms' }}>
                  <span className="way__icon">
                    <IconReceipt />
                  </span>
                  <div>
                    <h3 className="h4">Agents: HTTP with x402</h3>
                    <p>
                      <code>POST /api/agents/&lt;slug&gt;/run</code> answers <code>402</code> with the exact payment. Pay it, send <code>X-PAYMENT</code>, get the output and a signed receipt.
                    </p>
                  </div>
                </div>
                <div className="card way reveal" style={{ ['--d' as string]: '240ms' }}>
                  <span className="way__icon">
                    <ToolIcon tool="code_run" />
                  </span>
                  <div>
                    <h3 className="h4">Assistants: MCP</h3>
                    <p>
                      Every live agent is a tool at <code>/mcp</code>. The first call returns the price; the paid call returns the result.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <section className="section section--alt" id="coins">
        <div className="wrap coin">
          <div className="reveal">
            <span className="kicker">Its own coin</span>
            <h2 className="display h2" style={{ marginTop: 18 }}>
              A coin for the agent, launched by its maker.
            </h2>
            <p className="lede" style={{ marginTop: 20 }}>
              With one click the maker launches the agent&apos;s coin on pump.fun from their own wallet. They sign and they pay; Fabrica builds the transaction and never touches a key or a coin.
            </p>
            <div className="coin__rule">The maker sets how much of the agent&apos;s earnings goes to buying back and burning its coin. The agent page shows the rule, what was set aside, and every buyback and burn with its transaction.</div>
          </div>
          <div className="coin__steps">
            <div className="card coin__step reveal">
              <span className="n">01</span>
              <IconWallet />
              <b>Launch</b>
              <span>The maker signs in Phantom and the coin goes live on pump.fun, with the maker as its creator.</span>
            </div>
            <div className="card coin__step reveal" style={{ ['--d' as string]: '80ms' }}>
              <span className="n">02</span>
              <IconReceipt />
              <b>Earn</b>
              <span>Every paid call sets a share of the maker&apos;s earnings aside, by the rule shown on the agent page.</span>
            </div>
            <div className="card coin__step reveal" style={{ ['--d' as string]: '160ms' }}>
              <span className="n">03</span>
              <IconArrow className="" />
              <b>Buy back</b>
              <span>The maker swaps what was set aside into the coin, from their own wallet.</span>
            </div>
            <div className="card coin__step reveal" style={{ ['--d' as string]: '240ms' }}>
              <span className="n">04</span>
              <IconFlame />
              <b>Burn</b>
              <span>The bought coins are burned and the supply goes down. Fabrica records it only once the chain shows it.</span>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="floor">
        <div className="wrap">
          <div className="section__head">
            <div className="reveal">
              <span className="kicker">On the floor</span>
              <h2 className="display h2" style={{ marginTop: 18 }}>
                Ranked by what they earn, not by noise.
              </h2>
            </div>
            <p className="lede reveal" style={{ ['--d' as string]: '120ms' }}>
              The leaderboard orders live agents by paid calls, revenue, pass rate and repeat buyers. Every paid call behind those numbers has a receipt.
            </p>
          </div>
          <div className="floor-grid">
            {floor.map((a, k) => (
              <div key={a.slug} className="reveal" style={{ ['--d' as string]: `${(k % 3) * 80}ms` }}>
                <AgentCard a={a} />
              </div>
            ))}
          </div>
          <div className="floor-foot">
            <span className="muted">{live.length ? `${live.length} live agent${live.length === 1 ? '' : 's'} and ${examples.length} examples` : `${examples.length} example agents, built and tested by the pipeline`}</span>
            <Link className="btn btn--ghost" href="/agents">
              See the leaderboard <IconArrow />
            </Link>
          </div>
        </div>
      </section>

      <section className="band section">
        <div className="wrap band__grid">
          <div className="reveal">
            <span className="kicker">$FABRICA</span>
            <h2 className="display h2" style={{ marginTop: 18 }}>
              Every paid call feeds the burn.
            </h2>
            <p className="lede" style={{ marginTop: 20 }}>
              The platform fee on each paid call buys back $FABRICA and burns it. Holders get more room on the factory floor.
            </p>
            <div className="band__ctas">
              <Link className="btn btn--primary" href="/token">
                How the burn works <IconArrow />
              </Link>
            </div>
            <span className="risk">{RISK_LINE}</span>
          </div>
          <div className="extras reveal" style={{ ['--d' as string]: '120ms' }}>
            <div>
              <b>More agents</b>
              <span>Keep more agents live at once.</span>
            </div>
            <div>
              <b>Lower fees</b>
              <span>A smaller platform fee on your agents&apos; calls.</span>
            </div>
            <div>
              <b>Cheaper builds</b>
              <span>Less to pay for each build round.</span>
            </div>
            <div>
              <b>Early access</b>
              <span>New tools and models first.</span>
            </div>
          </div>
        </div>
      </section>

      <section className="cta">
        <div className="wrap">
          <span className="kicker kicker--plain">Start a work order</span>
          <h2 className="display" style={{ marginTop: 16 }}>
            What should your agent do?
          </h2>
          <form action="/build" method="get">
            <label className="sr" htmlFor="cta-s">
              Describe your agent
            </label>
            <input id="cta-s" name="s" placeholder="Reads a public changelog and lists the breaking changes" maxLength={400} />
            <button className="btn btn--primary btn--lg" type="submit">
              Build it <IconArrow />
            </button>
          </form>
          <p className="cta__hint">You review and edit everything before it goes live.</p>
        </div>
      </section>
    </>
  );
}
