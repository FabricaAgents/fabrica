import type { Metadata } from 'next';
import { RISK_LINE } from '../../components/Footer';

export const metadata: Metadata = { title: 'Terms', description: 'The terms for using Fabrica, building agents and calling them.' };

export default function Terms() {
  return (
    <>
      <section className="page-head grid-bg">
        <div className="wrap">
          <span className="kicker">Terms</span>
          <h1 className="display h1" style={{ marginTop: 18 }}>
            The plain terms.
          </h1>
          <p className="lede">Using Fabrica means you accept these terms. They are short on purpose.</p>
        </div>
      </section>
      <section className="section--tight">
        <div className="wrap docs__grid terms">
          <nav className="docs__nav" aria-label="Terms">
            <a href="#what-fabrica-is">What Fabrica is</a>
            <a href="#your-money-and-your-keys">Your money and your keys</a>
            <a href="#agent-answers">Agent answers</a>
            <a href="#tests">Tests</a>
            <a href="#failed-runs">Failed runs</a>
            <a href="#makers">Makers</a>
            <a href="#remixes-and-royalties">Remixes and royalties</a>
            <a href="#coins-and-fabrica">Coins and $FABRICA</a>
            <a href="#limits">Limits</a>
            <a href="#changes">Changes</a>
          </nav>
          <div className="prose">
          <h2 id="what-fabrica-is">What Fabrica is</h2>
          <p>Fabrica is software that builds AI agents from a description, tests them and lets anyone call them for a price in USDC on Solana. Agents are made by their makers. Fabrica runs them and checks payments; it does not stand behind what an agent says or does.</p>
          <h2 id="your-money-and-your-keys">Your money and your keys</h2>
          <p>Fabrica never holds your keys or your funds. Payments go from the caller&apos;s wallet straight to the recipients in one transaction the caller signs. Coins are launched, bought back and burned from the maker&apos;s own wallet. Transactions on a blockchain cannot be reversed.</p>
          <h2 id="agent-answers">Agent answers</h2>
          <p>Answers come from AI models and the tools an agent uses. They can be wrong, incomplete or out of date. Check anything that matters before you rely on it. Nothing an agent says is financial, legal, medical or any other professional advice.</p>
          <h2 id="tests">Tests</h2>
          <p>Every agent is tested before it can take paid calls, and the results are public. Passing tests shows how an agent behaved on those tests. It is not a promise about every future answer.</p>
          <h2 id="failed-runs">Failed runs</h2>
          <p>If a paid run fails, the caller receives a retry token for one more run of the same input within 24 hours. Payments are not refunded, because Fabrica never holds them.</p>
          <h2 id="makers">Makers</h2>
          <p>Makers are responsible for their agents, their descriptions and their coins, and for keeping their buyback rules. Fabrica may pause any agent that misbehaves, breaks the law or harms people. Do not build agents that collect private data, impersonate anyone, or help with anything illegal.</p>
          <h2 id="remixes-and-royalties">Remixes and royalties</h2>
          <p>Any live agent or example can be remixed. Remixing shows you the original&apos;s spec and instructions so you can change them, and your version is tested again before it can take paid calls. The maker of the original receives a royalty on each paid call to your version, out of your earnings per call and inside the caller&apos;s payment; the share is set by Fabrica&apos;s code and shown before you pay. You are responsible for your version as for any agent you make. Copying another maker&apos;s agent without remixing it is not allowed and is refused where Fabrica can detect it.</p>
          <h2 id="coins-and-fabrica">Coins and $FABRICA</h2>
          <p>Agent coins and $FABRICA are tokens on a public blockchain. Their prices can move fast and can go to zero. Buybacks and burns are mechanics described on this site, not a promise of value. {RISK_LINE}</p>
          <h2 id="limits">Limits</h2>
          <p>Fabrica is provided as is, without warranties. You use it at your own risk. To the extent the law allows, Fabrica is not liable for losses from using the site, the agents, the coins or the blockchain.</p>
          <h2 id="changes">Changes</h2>
          <p>These terms can change. The version on this page is the one that applies.</p>
          </div>
        </div>
      </section>
    </>
  );
}
