import Link from 'next/link';
import type { Metadata } from 'next';
import { connection } from 'next/server';
import { engine } from '../../lib/server';
import { RISK_LINE } from '../../components/Footer';
import { IconArrow } from '../../components/Icons';
import { ago, compact, shortAddr, solscanToken, solscanTx, tokenAmount, usd } from '../../shared/format';

export const metadata: Metadata = { title: '$FABRICA', description: 'The platform fee on every paid call buys back and burns $FABRICA. Holders get more room on the factory floor.' };

export default async function TokenPage() {
  await connection();
  const e = engine();
  const cfg = e.siteConfig();
  const stats = await e.token.stats();
  const tiers = cfg.tiers;
  return (
    <>
      <section className="page-head grid-bg">
        <div className="wrap token-hero">
          <div>
            <span className="kicker">$FABRICA</span>
            <h1 className="display h1" style={{ marginTop: 18 }}>
              Every paid call feeds the burn.
            </h1>
            <p className="lede">Each paid call on Fabrica carries a platform fee. The fee lands in a burn wallet in USDC, is swapped into $FABRICA on the open market, and the $FABRICA is burned, so the supply goes down. Each step is a transaction anyone can check.</p>
            <div className="hero__ctas">
              {stats?.mint ? (
                <>
                  <a className="btn btn--primary btn--lg" href={`https://pump.fun/coin/${stats!.mint}`} target="_blank" rel="noopener noreferrer">
                    Buy $FABRICA <IconArrow />
                  </a>
                  <a className="btn btn--ghost btn--lg" href={`https://dexscreener.com/solana/${stats!.mint}`} target="_blank" rel="noopener noreferrer">
                    Chart
                  </a>
                  <Link className="btn btn--ghost btn--lg" href="/agents">
                    See the agents
                  </Link>
                </>
              ) : (
                <>
                  <Link className="btn btn--primary btn--lg" href="/agents">
                    See the agents <IconArrow />
                  </Link>
                  <Link className="btn btn--ghost btn--lg" href="/docs#x402">
                    How calls are paid
                  </Link>
                </>
              )}
            </div>
          </div>
          <div className="burn-vis" aria-hidden="true">
            <svg viewBox="0 18 460 300" fill="none">
              <g fontFamily="var(--font-mono)" fontSize="11" fill="#8f939b" letterSpacing="1.4">
                <text x="40" y="58">PAID CALLS</text>
                <text x="190" y="58">FEE, USDC</text>
                <text x="330" y="58">BURN</text>
              </g>
              {[110, 170, 230, 290].map((y, i) => (
                <g key={y}>
                  <rect x="40" y={y - 16} width="96" height="32" rx="6" fill="#1b1e24" stroke="#2a2e35" />
                  <rect x="52" y={y - 4} width={40 + i * 8} height="8" rx="3" fill="#3a3f47" />
                  <path className="flow" d={`M136 ${y} C 170 ${y}, 170 200, 200 200`} stroke="#6f84ff" strokeWidth="1.8" style={{ animationDelay: `${i * 0.15}s` }} />
                </g>
              ))}
              <rect x="200" y="172" width="96" height="56" rx="10" fill="#171c33" stroke="#3a4580" />
              <text x="248" y="205" textAnchor="middle" fill="#e9e7e1" fontFamily="var(--font-display)" fontWeight="700" fontSize="20">
                SWAP
              </text>
              <path className="flow" d="M296 200 L 336 200" stroke="#f2c230" strokeWidth="2" />
              <circle cx="372" cy="200" r="34" fill="#22160f" stroke="#f0705d" />
              <path d="M372 222c-9 0-15-6-15-14 0-8 5-12 8-18 1 4 4 7 6 8 1-6 5-12 9-16 1 8 7 13 7 24 0 9-6 16-15 16z" fill="#f0705d" />
              {[0, 1, 2].map((k) => (
                <circle key={k} className="ember" cx={362 + k * 10} cy="170" r="2.5" fill="#f2c230" style={{ animationDelay: `${k * 0.8}s` }} />
              ))}
              <text x="372" y="262" textAnchor="middle" fill="#8f939b" fontFamily="var(--font-mono)" fontSize="11">
                SUPPLY DOWN
              </text>
            </svg>
          </div>
        </div>
      </section>

      <section className="section--tight">
        <div className="wrap">
          {stats ? (
            <>
              <div className="block-head">
                <div>
                  <span className="kicker">The burn record</span>
                  <h2 className="h3" style={{ marginTop: 10 }}>
                    Mint{' '}
                    <a className="link" href={solscanToken(stats.mint)} target="_blank" rel="noopener noreferrer">
                      {shortAddr(stats.mint, 6)}
                    </a>
                  </h2>
                </div>
              </div>
              <div className="stats" style={{ ['--n' as string]: 4 }}>
                <div className="stat">
                  <div className="stat__label">Supply now</div>
                  <div className="stat__value">{stats.supply ? tokenAmount(stats.supply.amount, stats.supply.decimals) : 'Reading'}</div>
                </div>
                <div className="stat">
                  <div className="stat__label">Burned by fees</div>
                  <div className="stat__value">{tokenAmount(stats.burnedRaw, stats.supply?.decimals ?? 6)}</div>
                </div>
                <div className="stat">
                  <div className="stat__label">Fees spent on buybacks</div>
                  <div className="stat__value">{usd(stats.usdcSpent)}</div>
                </div>
                <div className="stat">
                  <div className="stat__label">Paid calls</div>
                  <div className="stat__value">{compact(stats.paidCalls)}</div>
                </div>
              </div>
              {stats.burns.length ? (
                <div className="table-wrap" style={{ marginTop: 20 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th className="num">USDC</th>
                        <th className="num">Burned</th>
                        <th>Transactions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.burns.map((b) => (
                        <tr key={b.burn_sig}>
                          <td>{ago(b.created_at)}</td>
                          <td className="num">{usd(b.usdc_spent)}</td>
                          <td className="num">{tokenAmount(b.tokens_burned, stats.supply?.decimals ?? 6)}</td>
                          <td>
                            {b.swap_sig ? (
                              <a className="link" href={solscanTx(b.swap_sig)} target="_blank" rel="noopener noreferrer">
                                swap
                              </a>
                            ) : null}{' '}
                            <a className="link" href={solscanTx(b.burn_sig)} target="_blank" rel="noopener noreferrer">
                              burn
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="block-lede" style={{ marginTop: 16 }}>
                  The first burn runs once enough fees have gathered. It will be listed here with both transactions.
                </p>
              )}
            </>
          ) : (
            <div className="panel status-card">
              <div className="row">
                <span className="kicker kicker--plain">Status</span>
                <span className="badge badge--hazard">Not launched</span>
              </div>
              <h2 className="h3">$FABRICA has not launched yet.</h2>
              <p className="muted" style={{ margin: 0 }}>
                The mint address, the supply and the full burn record appear here on launch day. Until then there is nothing to buy, and any coin claiming to be $FABRICA is not.
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="section--tight" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="wrap">
          <div className="block-head">
            <div>
              <span className="kicker">Holder extras</span>
              <h2 className="h3" style={{ marginTop: 10 }}>
                Holding $FABRICA gives makers more room
              </h2>
            </div>
          </div>
          <p className="block-lede">Extras follow the balance in the wallet a maker signs in with, read from the chain. {tiers ? 'The levels:' : 'The holding levels are published at launch.'}</p>
          <div className="tiers">
            <div className="card">
              <b>More agents</b>
              <span>Keep more agents live at the same time. Everyone starts with {cfg.baseTier.liveAgents}.</span>
            </div>
            <div className="card">
              <b>Lower fees</b>
              <span>A smaller platform fee on your agents&apos; calls, so you keep more or price lower.</span>
            </div>
            <div className="card">
              <b>Cheaper builds</b>
              <span>Pay less for each build round of spec, tests and test runs.</span>
            </div>
            <div className="card">
              <b>Early access</b>
              <span>New tools and models open to holders first.</span>
            </div>
          </div>
          {tiers ? (
            <div className="table-wrap" style={{ marginTop: 20 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Level</th>
                    <th className="num">Hold at least</th>
                    <th className="num">Live agents</th>
                    <th className="num">Build discount</th>
                    <th className="num">Fee discount</th>
                    <th>Early access</th>
                  </tr>
                </thead>
                <tbody>
                  {tiers.map((t) => (
                    <tr key={t.name}>
                      <td>{t.name}</td>
                      <td className="num">{compact(t.minTokens)}</td>
                      <td className="num">{t.liveAgents}</td>
                      <td className="num">{t.buildDiscountBps / 100}%</td>
                      <td className="num">{t.feeDiscountBps / 100}%</td>
                      <td>{t.earlyAccess ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className="risk" style={{ marginTop: 28 }}>
            {RISK_LINE}
          </p>
        </div>
      </section>
    </>
  );
}
