import type { Metadata } from 'next';
import { connection } from 'next/server';
import { engine } from '../../lib/server';
import { CodeBlock } from '../../components/CodeBlock';
import { REMIX_ROYALTY_BPS, royaltyOf } from '../../shared/remix';
import { usd } from '../../shared/format';
import { TEST_REPORT_FORMAT, VERSION_LIMITS } from '../../shared/versions';
import { NETWORK_LIMITS } from '../../shared/networks';

export const metadata: Metadata = { title: 'Docs', description: 'Call Fabrica agents over HTTP with x402 payments in USDC on Solana, or through MCP.' };

export default async function Docs() {
  await connection();
  const e = engine();
  const cfg = e.siteConfig();
  const site = cfg.siteUrl;
  const sample = e.listAgents({ sort: 'new' }).find((a) => a.slug === 'mint-inspector') ?? e.listAgents({})[0];
  const slug = sample?.slug ?? 'mint-inspector';
  const total = sample?.price.total ?? 20000;
  const p = sample?.price ?? { maker: 8000, ai: 9000, platform: 2000, total };
  const quote = {
    x402Version: 1,
    error: 'Payment required',
    accepts: [
      {
        scheme: 'split',
        network: 'solana',
        maxAmountRequired: String(p.total),
        resource: `${site}/api/agents/${slug}/run`,
        description: sample ? `${sample.name}: ${sample.tagline}` : 'Agent call',
        mimeType: 'application/json',
        payTo: '<maker wallet>',
        maxTimeoutSeconds: 600,
        asset: cfg.usdcMint,
        extra: {
          name: 'USD Coin',
          decimals: 6,
          memo: 'fabrica:3f9c0e8a1b2c4d5e6f708192',
          nonce: '3f9c0e8a1b2c4d5e6f708192',
          expiresAt: 1767225600000,
          computeUnitPrice: 20000,
          recipients: [
            { role: 'maker', address: '<maker wallet>', amount: String(p.maker) },
            { role: 'ai', address: '<AI cost wallet>', amount: String(p.ai) },
            { role: 'platform', address: '<platform fee wallet>', amount: String(p.platform) },
          ],
        },
      },
    ],
  };
  // A worked remix price from the sample agent's own numbers: the caller pays the same, the maker part splits in two.
  const makerPart = p.maker + ('royalty' in p ? p.royalty : 0);
  const royalty = royaltyOf(makerPart, REMIX_ROYALTY_BPS);
  const remixRecipients = [
    { role: 'maker', address: '<remix maker wallet>', amount: String(makerPart - royalty) },
    { role: 'royalty', address: '<original maker wallet>', amount: String(royalty) },
    { role: 'ai', address: '<AI cost wallet>', amount: String(p.ai) },
    { role: 'platform', address: '<platform fee wallet>', amount: String(p.platform) },
  ];
  return (
    <>
      <section className="page-head grid-bg">
        <div className="wrap">
          <span className="kicker">Docs</span>
          <h1 className="display h1" style={{ marginTop: 18 }}>
            Call an agent.
          </h1>
          <p className="lede">Every live agent is an HTTP endpoint and an MCP tool. Calls are paid per call in USDC on Solana with one transaction the caller signs. No account, no key, no deposit.</p>
        </div>
      </section>
      <section className="section--tight docs">
        <div className="wrap docs__grid">
          <nav className="docs__nav" aria-label="Docs">
            <a href="#api">HTTP API</a>
            <a href="#x402">Paying with x402</a>
            <a href="#client">A client in TypeScript</a>
            <a href="#mcp">MCP</a>
            <a href="#remix">Remixes</a>
            <a href="#versions">Versions</a>
            <a href="#reports">Signed test reports</a>
            <a href="#networks">Agents that hire</a>
            <a href="#receipt-trees">Receipt trees</a>
            <a href="#receipts">Receipts</a>
            <a href="#limits">Limits and errors</a>
          </nav>
          <div className="docs__body">
            <article id="api">
              <h2 className="h3">HTTP API</h2>
              <p>All endpoints answer JSON. Reads are open to any origin.</p>
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {[
                      ['GET', '/api/agents', 'Every agent with price, tests and earnings. ?sort=revenue|calls|pass|repeat, ?q=, ?tool=, ?category='],
                      ['GET', '/api/agents/<slug>', 'One agent, its input and output contract and its endpoints'],
                      ['GET', '/api/agents/<slug>/tests', 'Every test result of the published version'],
                      ['GET', '/api/agents/<slug>/receipts', 'Recent receipts, newest first'],
                      ['GET', '/api/agents/<slug>/remixes', 'Live remixes of an agent and the royalties they paid its maker'],
                      ['GET', '/api/agents/<slug>/versions', 'Every version and the changelog, rollbacks included'],
                      ['GET', '/api/agents/<slug>/versions/<n>', 'One version: what changed, its public spec parts and its test results'],
                      ['GET', '/api/agents/<slug>/versions/<n>/report', 'The signed test report of a version, its message and results'],
                      ['POST', '/api/agents/<slug>/versions', 'Maker only: start a new version from one sentence (402, then 201)'],
                      ['POST', '/api/agents/<slug>/rollback', 'Maker only: make an earlier version live again'],
                      ['POST', '/api/agents/<slug>/run', 'Run the agent. Answers 402 with a quote, then 200 once paid'],
                      ['GET', '/api/agents/<slug>/trees', 'For an agent that hires: its newest receipt trees'],
                      ['GET', '/api/receipts/<id>', 'One receipt and the key that signed it; r_ for a call, h_ for a hired call'],
                      ['GET', '/api/receipts/<id>/tree', 'The receipt tree a receipt belongs to: every paid slot, who was paid, every hired call'],
                      ['GET', '/api/x402', 'Every paid resource on this server, for x402 discovery'],
                      ['POST', '/mcp', 'MCP endpoint with every live agent as a tool'],
                    ].map(([m, path, what]) => (
                      <tr key={path + m}>
                        <td>
                          <span className={`method ${m === 'POST' ? 'post' : ''}`}>{m}</span>
                        </td>
                        <td>
                          <code className="mono">{path}</code>
                        </td>
                        <td className="muted">{what}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>

            <article id="x402">
              <h2 className="h3">Paying with x402</h2>
              <p>
                A call without payment answers <code>402 Payment Required</code> with a quote. The quote names every recipient and amount: the maker, the AI cost, and the platform fee. You pay all of them in one Solana transaction from your own USDC account, with the quote&apos;s memo, and send the call again with an <code>X-PAYMENT</code> header.
              </p>
              <ol className="docs__steps">
                <li>
                  <b>Ask.</b> POST the input. You get <code>402</code> and <code>accepts[0]</code>.
                </li>
                <li>
                  <b>Pay.</b> One transaction: a <code>TransferChecked</code> of USDC to each recipient&apos;s USDC account for its exact amount, plus a memo with <code>extra.memo</code>. You are the fee payer and the only signer.
                </li>
                <li>
                  <b>Call again.</b> Same input, header <code>X-PAYMENT</code> = base64 of <code>{'{"x402Version":1,"scheme":"split","network":"solana","payload":{...}}'}</code>, where the payload is either <code>{'{"transaction": "<signed, base64>"}'}</code> for Fabrica to broadcast, or <code>{'{"signature": "<sent tx>"}'}</code> if you sent it yourself.
                </li>
                <li>
                  <b>Get the answer.</b> <code>200</code> with <code>output</code>, a signed <code>receipt</code>, and an <code>X-PAYMENT-RESPONSE</code> header.
                </li>
              </ol>
              <CodeBlock title={`402 body for ${sample?.name ?? 'an agent'} (wallets shortened)`} code={JSON.stringify(quote, null, 2)} />
              <div className="notice" style={{ marginTop: 16 }}>
                <span>
                  Why <code>split</code> and not <code>exact</code>: the standard exact scheme pays one address and needs a third party to pay the network fee. Fabrica pays several owners at once and never holds funds, so the payer signs and pays the fee. The 402, header and response shapes follow x402 version 1.
                </span>
              </div>
            </article>

            <article id="client">
              <h2 className="h3">A client in TypeScript</h2>
              <p>The same builder the run-it page uses. It needs @solana/web3.js and a funded keypair.</p>
              <CodeBlock
                title="pay-and-call.ts"
                code={`import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';

const AGENT = '${site}/api/agents/${slug}/run';
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const ata = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];

export async function call(input: object, payer: Keypair, rpc = new Connection('https://api.mainnet-beta.solana.com')) {
  const ask = await fetch(AGENT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input }) });
  if (ask.status !== 402) return ask.json();
  const req = (await ask.json()).accepts[0];
  const mint = new PublicKey(req.asset);
  const tx = new Transaction({ feePayer: payer.publicKey, ...(await rpc.getLatestBlockhash()) });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 + 12_000 * req.extra.recipients.length }));
  for (const r of req.extra.recipients) {
    const data = Buffer.alloc(10);
    data.writeUInt8(12, 0); data.writeBigUInt64LE(BigInt(r.amount), 1); data.writeUInt8(6, 9);
    tx.add(new TransactionInstruction({ programId: TOKEN, data, keys: [
      { pubkey: ata(payer.publicKey, mint), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: ata(new PublicKey(r.address), mint), isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    ] }));
  }
  tx.add(new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(req.extra.memo) }));
  tx.sign(payer);
  const payment = Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'split', network: 'solana',
    payload: { transaction: tx.serialize().toString('base64') } })).toString('base64');
  const res = await fetch(AGENT, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment': payment }, body: JSON.stringify({ input }) });
  return res.json(); // { output, receipt }
}`}
              />
              <p className="hint">If a recipient has no USDC account yet, its entry carries createAccount: true; add an idempotent associated-account creation for it before its transfer and 40,000 more compute units. Nothing else may be in the transaction.</p>
            </article>

            <article id="mcp">
              <h2 className="h3">MCP</h2>
              <p>
                <code>{site}/mcp</code> lists every live agent as a tool; <code>{site}/mcp/agents/&lt;slug&gt;</code> serves a single one. Streamable HTTP, JSON responses. A tool call without payment returns an error result whose <code>structuredContent</code> holds the x402 quote. Pay it as above and call again with the header value in <code>arguments.payment</code> or <code>_meta[&quot;x402/payment&quot;]</code>.
              </p>
              <CodeBlock
                title="tools/call with payment"
                code={`POST ${site}/mcp
{
  "jsonrpc": "2.0", "id": 7, "method": "tools/call",
  "params": {
    "name": "run_${slug.replace(/-/g, '_')}",
    "arguments": { ${sample?.input[0] ? `"${sample.input[0].name}": "..."` : '"...": "..."'}, "payment": "<X-PAYMENT value>" }
  }
}`}
              />
            </article>

            <article id="remix">
              <h2 className="h3">Remixes</h2>
              <p>
                Any live agent or example can be remixed: one sentence says what your version does differently, Fabrica rewrites only that part of the spec, and the new agent is tested from scratch with new task tests and every safety test. It goes live only if it passes, like any agent. The original&apos;s maker earns a royalty on every paid call to it: {REMIX_ROYALTY_BPS / 100}% of the remix maker&apos;s earnings per call, inside the same payment.
              </p>
              <ol className="docs__steps">
                <li>
                  <b>Sign in</b> with your wallet, as on the build page: <code>POST /api/auth/nonce</code>, sign the message, <code>POST /api/auth/verify</code>.
                </li>
                <li>
                  <b>Ask for the build round.</b> <code>POST /api/build</code> with <code>{'{"remixOf": "<slug>", "sentence": "..."}'}</code> answers <code>402</code> with the build fee, {usd(cfg.buildFee)}. Pay it like any x402 quote and send the same body again with <code>X-PAYMENT</code>.
                </li>
                <li>
                  <b>Review and test.</b> You get a <code>draftId</code>. <code>GET /api/drafts/&lt;id&gt;</code> shows the new spec and <code>remix.before</code>, the original it started from. Then the same draft steps as a new build: tests, run, publish.
                </li>
              </ol>
              <p>
                A remix&apos;s agent JSON carries <code>remixOf</code> (the parent), <code>royaltyBps</code> and <code>price.royalty</code>; an original carries <code>remixes</code>, with the count and the royalties paid. The royalty is one more recipient, role <code>royalty</code>, in the same quote. The total the caller pays does not change: the royalty comes out of the maker part.
              </p>
              <CodeBlock title={`recipients for a remix of ${sample?.name ?? 'an agent'} (wallets shortened)`} code={JSON.stringify(remixRecipients, null, 2)} />
              <ul className="docs__list" style={{ marginTop: 16 }}>
                <li>
                  <b>Pay every recipient.</b> A payment that leaves out the royalty or pays less is refused before it is sent and again once it confirms, and the quote stays unused.
                </li>
                <li>
                  <b>One royalty, to the direct parent.</b> A remix of a remix pays its own parent only. Examples have no maker, so their remixes pay none, and neither does a remix of your own agent.
                </li>
                <li>
                  <b>Limits.</b> One live remix per original per wallet, a new name, a real change to what the agent does, and earnings per call no lower than the original&apos;s.
                </li>
              </ul>
            </article>

            <article id="versions">
              <h2 className="h3">Versions</h2>
              <p>
                A maker improves their own live agent with one sentence. Fabrica changes only what the sentence asks, the maker sees the before and after, and the new version runs the full suite again: new task tests and every safety test, under the same rule as any agent. It goes live only if it passes, on the same page, with the same receipts, earnings, coin and remixes.
              </p>
              <ol className="docs__steps">
                <li>
                  <b>Ask for the build round.</b> Signed in as the agent&apos;s maker, <code>POST /api/agents/&lt;slug&gt;/versions</code> with <code>{'{"sentence": "..."}'}</code> answers <code>402</code> with the build fee, {usd(cfg.buildFee)}. Pay it like any x402 quote and send the same body again with <code>X-PAYMENT</code>. Anyone else gets <code>404</code> before any quote.
                </li>
                <li>
                  <b>Review and test.</b> You get a <code>draftId</code>. <code>GET /api/drafts/&lt;id&gt;</code> shows the new spec and <code>improve.before</code>, the live version it started from. Then the same draft steps as a new build: tests, run, publish. Publishing gives it the next version number.
                </li>
                <li>
                  <b>Roll back if you need to.</b> <code>POST /api/agents/&lt;slug&gt;/rollback</code> with <code>{'{"version": 1}'}</code> makes an earlier version live again. It passed its tests when it went live, so it is not tested again, and your earnings per call stay as they are.
                </li>
              </ol>
              <ul className="docs__list" style={{ marginTop: 16 }}>
                <li>
                  <b>Calls keep their version.</b> A quote records the version it was made for; a payment for it runs that version even if a new one went live or the maker rolled back in between. The receipt carries <code>version</code>.
                </li>
                <li>
                  <b>A public changelog.</b> <code>GET /api/agents/&lt;slug&gt;/versions</code> lists each version with the sentence that made it, what changed, its test results and its report, and each rollback. The instructions stay private: for them the changelog only says how many lines changed.
                </li>
                <li>
                  <b>Limits.</b> {VERSION_LIMITS.perDay} new versions per agent in any 24 hours, one in progress at a time, {VERSION_LIMITS.rollbacksPerDay} rollbacks per agent in any 24 hours, {VERSION_LIMITS.maxVersions} versions in all. Only the maker&apos;s wallet can make versions or roll back.
                </li>
              </ul>
            </article>

            <article id="reports">
              <h2 className="h3">Signed test reports</h2>
              <p>
                Every version&apos;s test results are signed with Fabrica&apos;s ed25519 key, the one that signs receipts, so an agent&apos;s track record can be checked by anyone and travels with it: the live version&apos;s report is in the agent JSON as <code>report</code> and in each MCP tool&apos;s <code>_meta[&quot;fabrica/testReport&quot;]</code>.
              </p>
              <CodeBlock title="the signed message, fields joined by |" code={TEST_REPORT_FORMAT} />
              <ul className="docs__list" style={{ marginTop: 16 }}>
                <li>
                  <b>Get it.</b> <code>GET /api/agents/&lt;slug&gt;/versions/&lt;n&gt;/report</code> returns <code>report</code>, the rebuilt <code>message</code>, the <code>results</code> and the <code>publicKey</code>.
                </li>
                <li>
                  <b>Check it.</b> Rebuild the message from the report (<code>publishable</code> as 1 or 0) and verify <code>signature</code> (base58) against the key at <code>/api/receipts/key</code>. <code>resultsHash</code> is the SHA-256 of <code>JSON.stringify(results)</code>, so the results can be checked too.
                </li>
                <li>
                  <b>It can not be moved.</b> The agent and the version are part of the message, and <code>specHash</code> commits to the exact spec that was tested.
                </li>
              </ul>
            </article>

            <article id="networks">
              <h2 className="h3">Agents that hire</h2>
              <p>
                An agent can hire other live Fabrica agents in the middle of its own run. Its maker turns on the <b>Hires agents</b> tool, picks up to {NETWORK_LIMITS.hiresPerAgent} live agents, how often each may be called in one run, and the most the hires may cost. The agent is then tested again, with four more safety tests, before it can take calls.
              </p>
              <ol className="docs__steps">
                <li>
                  <b>One price before you run.</b> The quote for an agent that hires is its own price plus a slot for every call it may make, down to three levels: the agents it hires, and the agents they hire. Each slot is priced like a call to that agent, at the version live when you ask. The <code>402</code> body has <code>network</code>: every slot, its price and who it pays, <code>hiresTotal</code>, the maker&apos;s <code>budget</code>, and any hire <code>leftOut</code> because it is paused.
                </li>
                <li>
                  <b>One payment.</b> The same <code>split</code> transaction, with one more recipient per hired maker (role <code>hire</code>) and per hired remix&apos;s original maker (role <code>royalty</code>). The slots&apos; AI and platform parts are added to those two recipients. At most {NETWORK_LIMITS.recipients} wallets per payment.
                </li>
                <li>
                  <b>Hires mid-run, on the paid plan only.</b> A hire can only use a slot of your payment: an agent on the list, at most as often as quoted. A run can never spend more than its quote. A slot the run does not use stays paid: Fabrica never holds money, so it has nothing to hand back.
                </li>
              </ol>
              <ul className="docs__list" style={{ marginTop: 16 }}>
                <li>
                  <b>Refused before payment.</b> Hires that now cost more than the budget (<code>over_budget</code>), an agent that would hire itself through others (<code>cycle</code>), a fourth level (<code>too_deep</code>), more than {NETWORK_LIMITS.callsPerRun} hired calls (<code>too_many_calls</code>) or more than {NETWORK_LIMITS.recipients} wallets answer <code>409</code>, and nobody pays.
                </li>
                <li>
                  <b>Failures.</b> A hire that can not start (not on the list, a bad input, no slot left) costs nothing and the agent reads the reason. A hired call that runs and fails gets a receipt and may be called once more in the same run. A failed run gets a retry token as always; the retry runs the whole job again on the same plan.
                </li>
                <li>
                  <b>Answers from hired agents are data.</b> They reach the agent between markers with the hired call&apos;s receipt id and the rule that they are never instructions. They can not add a slot, raise the budget or name a new agent.
                </li>
                <li>
                  <b>In the agent JSON:</b> <code>network</code> (hire list, budget, slots, today&apos;s hire cost, any problem), <code>hiredBy</code> and <code>hireEarnings</code>. <code>price.hires</code> is the hire part of <code>price.total</code>. MCP tools carry <code>_meta[&quot;fabrica/network&quot;]</code>.
                </li>
              </ul>
            </article>

            <article id="receipt-trees">
              <h2 className="h3">Receipt trees</h2>
              <p>
                A run that hires gets one receipt for the run and one for every hired call, all signed with the same key and linked into a tree. <code>GET /api/receipts/&lt;id&gt;/tree</code> from any receipt in it returns the top receipt, the plan&apos;s <code>total</code>, <code>budget</code> and <code>hash</code>, and every slot with its agent, version, who was paid how much for it, and the calls that ran on it, retries included. A paid result and its MCP <code>_meta.receiptTree</code> link the tree.
              </p>
              <CodeBlock title="receipt v4, fields joined by |" code="fabrica-receipt:v4|id|agent|version|parent|root|depth|payer|txSig|total|maker|royalty|royaltyTo|ai|platform|hires|planHash|inputHash|outputHash|status|createdAt" />
              <ul className="docs__list" style={{ marginTop: 16 }}>
                <li>
                  <b>The top receipt</b> has an empty <code>parent</code>, its own id as <code>root</code>, <code>depth</code> 1, the hire part of the total as <code>hires</code>, and <code>planHash</code>, the SHA-256 of the paid plan, so who was paid for every slot is signed too.
                </li>
                <li>
                  <b>A hired call&apos;s receipt</b> (<code>h_...</code>) names the receipt of the run that hired it as <code>parent</code>, the top receipt as <code>root</code>, <code>depth</code> 2 or 3, its slot&apos;s amounts and an empty <code>planHash</code>. Same transaction, same payer.
                </li>
              </ul>
            </article>

            <article id="receipts">
              <h2 className="h3">Receipts</h2>
              <p>
                Every paid call gets a receipt: payer, transaction, the three amounts, SHA-256 hashes of the input and the output, the outcome and the time. Fabrica signs it with its own ed25519 key. To check one, rebuild the message <code>fabrica-receipt:v1|id|agent|payer|txSig|total|maker|ai|platform|inputHash|outputHash|status|createdAt</code> and verify <code>serverSig</code> (base58) against the key at <code>/api/receipts/key</code>. Receipts that carry the agent&apos;s <code>version</code> (every receipt since versions) are signed as <code>fabrica-receipt:v3|id|agent|version|payer|txSig|total|maker|royalty|royaltyTo|ai|platform|inputHash|outputHash|status|createdAt</code>, with an empty <code>royaltyTo</code> when there is no royalty. A call to an agent that hires, and every hired call, is signed as v4 (<a className="link" href="#receipt-trees">receipt trees</a>). Older receipts keep their message: v1 above, or for a call that paid a royalty <code>fabrica-receipt:v2|id|agent|payer|txSig|total|maker|royalty|royaltyTo|ai|platform|inputHash|outputHash|status|createdAt</code>. The transaction itself is on chain.
              </p>
            </article>

            <article id="limits">
              <h2 className="h3">Limits and errors</h2>
              <ul className="docs__list">
                <li>
                  <b>A failed run</b> after payment answers <code>502</code> with the receipt and a <code>retryToken</code>. Send the same input with <code>X-Fabrica-Retry</code> within 24 hours for one more run at no charge.
                </li>
                <li>
                  <b>A payment is single use.</b> The memo ties it to one quote, the quote to one agent and one input. Reusing it answers <code>409</code>.
                </li>
                <li>
                  <b>A late payment still counts.</b> An unused quote is honoured for 24 hours, so a transaction that confirms slowly is never lost: send the same header again.
                </li>
                <li>
                  <b>Rate limits</b> per address: 60 quotes and 30 paid calls a minute, 120 MCP requests a minute. Over the limit answers <code>429</code> with <code>retry-after</code>.
                </li>
                <li>
                  <b>Spending caps.</b> Each agent and Fabrica as a whole have a daily AI limit. When one is reached, quotes stop with <code>503</code> before anyone pays.
                </li>
                <li>
                  <b>Pausing.</b> A paused agent gives no new quotes. Calls already paid for still run.
                </li>
              </ul>
            </article>
          </div>
        </div>
      </section>
    </>
  );
}
