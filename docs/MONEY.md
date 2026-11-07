# How money moves in Fabrica

The rule: **Fabrica never holds anyone's money or keys.** Every design choice below follows from it, and this
file only claims what the code does. The code paths are named so each claim can be checked.

## The design in one paragraph

A paid call is one Solana transaction, signed by the caller, that pays every recipient directly from the
caller's own USDC account: the maker, the AI cost, the platform fee and, when the agent is a remix, the original
maker's royalty and, when the agent hires other agents, every hired maker (docs/NETWORKS.md), each with a `TransferChecked` to the recipient's own USDC account, plus a memo that names the quote. There is no account in between, no program
that holds funds, no escrow, no deposit and no balance at Fabrica. Fabrica only reads the result on chain and
then runs the agent. (`shared/pay.ts` builds the transaction; `server/pay/verify.ts` checks it;
`server/pay/payments.ts` quotes and settles.)

## The x402 flow

1. `POST /api/agents/<slug>/run` without payment answers **402** with an x402 v1 body. `accepts[0]` uses the
   scheme **`split`**: `extra.recipients` lists each owner and exact amount in micro-USDC, `extra.memo` is
   `fabrica:<nonce>`.
2. The caller signs one transaction: compute budget, (optionally) idempotent creation of a recipient's USDC
   account if `createAccount` is set, one `TransferChecked` per recipient, one memo. The caller is the fee
   payer and the only signer.
3. The caller sends the same request with `X-PAYMENT` = base64 JSON `{x402Version:1, scheme:'split',
   network:'solana', payload}` where the payload is `{transaction}` (Fabrica broadcasts it) or `{signature}`
   (the caller already sent it; Phantom does this on the run-it page).
4. Fabrica checks, runs, signs a receipt and answers **200** with `X-PAYMENT-RESPONSE`.

**Why `split` and not the standard `exact` scheme.** `exact` pays a single `payTo` and has a third party (the
facilitator) pay the network fee. One address can not split to three owners without someone holding the money
first, and a facilitator needs a funded SOL wallet, which would be seed money. With `split` the payer pays the
network fee (a fraction of a cent) and nobody needs a float. The 402 body, the headers and the response header
follow x402 version 1; a generic x402 client will not know `split` and needs the 20-line client in the docs.

**Why not a small Anchor program as the split recipient.** It was considered and rejected:
- deploying it costs SOL for rent (about 1.5 to 2.5 SOL), which is seed money from the operator;
- funds would sit in a program account between payment and distribution, which needs a crank to move them and
  an upgrade authority someone holds: a custody window and a key that matters;
- the direct split does the same job with nothing in between.

## What the server checks (`server/pay/verify.ts`)

Before broadcasting a signed transaction (`checkRawTransaction`):
- the payer is the fee payer and the only signer, and the signature verifies;
- only compute budget, memo, idempotent account creation **for recipients only**, and `TransferChecked`
  instructions; no lookup tables; nothing else;
- every transfer comes from the payer's own USDC account, in the configured USDC mint with 6 decimals, signed
  by the payer, to a recipient's USDC account, for exactly the quoted amount, once per recipient;
- the memo equals the quote's memo.

After confirmation (`checkConfirmed`), on what the chain recorded (`jsonParsed`):
- the transaction succeeded;
- each recipient got exactly one checked transfer of its amount from the payer's USDC account;
- the memo matches;
- the recorded pre/post token balances show each recipient's account grew by at least its amount.
  Wallets may add their own guard instructions when they send; those are tolerated here because they can not
  move a recipient's money.

Then the quote is **claimed atomically** (`UPDATE ... WHERE claimed_sig IS NULL`); a transaction signature can
claim one quote only (unique index), and a quote is bound to one agent and one input hash. Signatures of
simulated transactions (all 1s) are refused.

These checks run against the pretend chain in the unit, integration, end-to-end and load tests, and against a
real local validator with the real token, memo and associated-account programs (`npm run test:validator`).

## Who gets what

| Part | Goes to | What it is |
|---|---|---|
| Maker | the maker's wallet | the price the maker set, less the royalty for a remix |
| Royalty | the original's maker wallet | only for a remix of an agent with a maker: 20% of the remix maker's part (`REMIX_ROYALTY_BPS`), rounded down to the micro-USDC. Out of the maker part, so the caller pays the same. |
| AI | `FABRICA_OPS_WALLET` | the most this call may spend on AI: `steps x (8000 prompt tokens x input price + answer tokens x output price)`. The run is stopped there (`server/runtime/run.ts`). |
| Platform fee | `FABRICA_BURN_WALLET` | a share of maker + AI with a floor (`FABRICA_PLATFORM_FEE_BPS`, `FABRICA_PLATFORM_FEE_MIN_USD`), lower for maker holder tiers. Buys back and burns $FABRICA. |
| Hire slots | each hired maker, its royalty owner, `FABRICA_OPS_WALLET`, `FABRICA_BURN_WALLET` | only for an agent that hires: one slot per call it may make, each priced like a call to that agent (maker part, royalty, AI ceiling, platform fee), in the same transaction (docs/NETWORKS.md). |
| Build round | `FABRICA_OPS_WALLET` | `FABRICA_BUILD_FEE_USD`, paid by the maker before any AI runs for the draft; covers the spec, the tests and up to three test runs. 90% of it is the draft's AI budget, enforced. |

The site never shows the platform fee as a percentage; amounts are shown per call.

## Remix royalties (`shared/remix.ts`, `server/pay/price.ts`, `server/calls.ts`)

A remix is an agent made from another live agent by one sentence (docs/REMIX.md). Its maker sets the maker part as
for any agent; 20% of it goes to the maker of the agent it was remixed from:

- **One more recipient in the same transaction**, role `royalty` in `extra.recipients`. It is quoted, signed,
  checked and claimed exactly like the others: before broadcast every recipient must get exactly its amount, after
  confirmation the recorded balances must show it arriving. A payment that leaves the royalty out, shortens it or
  pays it to anyone else is refused and the quote stays unused (tested in `test/unit/remix.test.ts`,
  `test/integration/remix.test.ts`, and against a real local validator in `npm run test:validator`).
- **The caller pays the same.** `priceFor` computes AI and platform fee on the full maker part, then splits the maker
  part into `maker` and `royalty`. `total = maker + royalty + ai + platform` holds for every quote.
- **Idempotent account creation** for the royalty wallet when it has never held USDC, paid by the caller as for any
  recipient. Four recipients that all need an account still fit one transaction (checked in the unit tests; 694
  bytes on the validator).
- **Fabrica holds nothing.** The royalty never passes through a Fabrica wallet. Who receives it is read from the
  database when each call is quoted: the maker wallet of the remix's direct parent (`agents.parent_id`). The share is
  fixed when the remix goes live (`agents.royalty_bps`); no endpoint changes it.
- **No royalty** when the parent is an example (it has no maker wallet) or when the remix's maker made the parent
  too. The quote then has the usual three recipients.
- **A remix of a remix** pays its direct parent only; one royalty recipient per payment, whatever the depth.
- **Receipts** carry `royalty` and `royaltyTo`. A receipt with a royalty, signed before versions, is signed over
  `fabrica-receipt:v2|id|agent|payer|txSig|total|maker|royalty|royaltyTo|ai|platform|inputHash|outputHash|status|createdAt`;
  one without keeps the v1 message, so every receipt signed before remixes still verifies. Since versions every
  receipt signs v3 (below), which carries the royalty fields too. `/api/receipts/key` returns every format.
- **Counting.** A remix's page shows what its maker earned and what it paid in royalties; the original's page shows
  the royalties its remixes paid. Calls by the remix's maker or by the original's maker are left out of the royalty
  totals, and royalties never count toward the original's place on the leaderboard.

## Versions (`server/versions.ts`, `server/calls.ts`, docs/VERSIONS.md)

A version moves no money of its own and adds no recipient:

- **A new version costs one ordinary build round**, the same `FABRICA_BUILD_FEE_USD` quote to `FABRICA_OPS_WALLET`
  as a new build or a remix, with the same AI budget for the draft (90% of it) and the same top-up for more runs.
- **A paid call runs the version it was quoted on.** The quote fixes the amounts and recipients as always and now
  also records the version (`quotes.version`). If the maker publishes or rolls back before the payment arrives,
  the payment still runs the quoted version, so the caller gets what was priced and the AI budget it paid for
  matches the model and steps that run.
- **Receipts** record the version and sign it: every receipt since versions uses
  `fabrica-receipt:v3|id|agent|version|payer|txSig|total|maker|royalty|royaltyTo|ai|platform|inputHash|outputHash|status|createdAt`
  (an empty `royaltyTo` when there is none). Receipts signed earlier keep v1 or v2 and still verify.
  `/api/receipts/key` returns all three formats and the test report format.
- **Earnings, receipts and royalties stay with the agent** across versions: they hang off the agent, not the
  version. A rollback keeps the maker's current price; a remix's price floor holds for every version.

## Agent networks (`server/networks.ts`, `server/calls.ts`, docs/NETWORKS.md)

An agent may hire other agents during its run. The money still moves in the caller's one transaction:

- **The plan is fixed at quote time.** For every agent on the hire list, a slot for each call it may make, down to
  three levels, each with the hired agent's version, maker wallet, royalty owner and its price for one call. The plan
  is stored with the quote (`quotes.plan`) and its hire part is `quotes.hires_amt`.
- **One more recipient per hired maker** (role `hire`), and per hired remix's original maker (role `royalty`), in the
  same transaction; the slots' AI and platform parts are added to the AI and platform recipients. Recipients with the
  same wallet are merged, and a payment pays at most 8 wallets (1142 bytes when all 8 need a new account; checked in
  the unit tests and on the validator). `total = maker + royalty + ai + platform + hires` holds for every quote, and the
  recipients add up to it.
- **Checked like every recipient.** A payment that leaves out or shortens a hired maker is refused before broadcast and
  on the confirmed transaction, and the quote is not used up (`test/integration/networks.test.ts`,
  `npm run test:validator`).
- **A run can not spend more than its quote.** A hire can only use a slot of the paid plan; each hired call runs with
  its own slot's AI ceiling as its AI budget. Nothing else can be spent.
- **Refused before anyone pays:** hires that cost more than the maker's budget, loops, a fourth level, more than 6
  hired calls, more than 8 wallets, a hired agent at its daily AI cap. Paused hires are left out of the plan.
- **A slot the run does not use stays paid.** Fabrica never holds the money, so there is nothing to return, the same
  as the unused part of an AI ceiling. The agent page shows how many paid slots its runs used.
- **Records.** `hire_slots` has one row per paid slot (who was paid how much), written with the top receipt; `hires`
  has one row per hired call that ran, with its own signed receipt. The top receipt signs the SHA-256 of the plan.
- **Counting.** Being hired is not a paid call of the hired agent and does not feed its place on the leaderboard; its
  page shows what hires earned its maker, leaving out runs paid by its own maker.

## No seed money, and the one honest exception

Every AI cost is paid by the caller (or the maker, for builds) **before** the AI runs, and no call can spend more
than it paid for. Daily caps per agent and overall (`FABRICA_AGENT_DAILY_AI_CAP_USD`,
`FABRICA_DAILY_AI_CAP_USD`) stop quotes **before** anyone pays when they are reached.

The exception is a property of OpenRouter, not of Fabrica: OpenRouter sells credit in advance. The AI share of
every payment lands in the ops wallet in USDC, and the operator turns it into OpenRouter credit. The account needs
some credit before the very first build can run; after that, revenue refills it faster than calls use it,
because every call pays its ceiling and real runs use a fraction of it. This top-up is manual: OpenRouter does
not take USDC on Solana directly (check its current payment options).

The burn keeper (below) needs a little SOL in the burn wallet for network fees. Fees can not buy that SOL
automatically, because the first swap would itself need SOL; the operator sends a few cents of SOL once, or burns
by hand from Phantom.

## Failed runs

Fabrica can not refund, because it never holds the payment. When a paid run fails, the receipt says so and the
caller gets a **retry token**: the same input, one more run, free, within 24 hours (`server/calls.ts`). A
payment that confirms late is honoured for 24 hours: send the same header again.

Pausing an agent stops new quotes. Calls already paid for still run.

## $FABRICA buyback and burn (`server/token/fabrica.ts`)

- Before launch (`FABRICA_MINT` empty) platform fees simply gather in the burn wallet, and the site shows no
  token numbers at all.
- After launch, with `FABRICA_BURN_SECRET` set, a keeper runs hourly: if the burn wallet holds at least
  `FABRICA_BURN_MIN_USD` of USDC it swaps it into $FABRICA through the swap router, then burns the wallet's
  whole $FABRICA balance with `BurnChecked` (supply goes down) and records both signatures. The burn wallet only
  ever holds platform fees, which are the platform's own revenue, never a user's money.
- Without the secret on the server, the operator swaps and burns from the burn wallet in Phantom and records the
  burn with `npm run admin -- record-burn <signature>`; it is only recorded if the chain shows a `BurnChecked`
  of $FABRICA signed by the burn wallet.
- Holder extras are read from the chain: the balance of the wallet a maker signs in with.

## Agent coins (`server/coins/coins.ts`, `components/agent/MakerPanel.tsx`)

- **Launch.** The browser builds the pump.fun `create_v2` transaction with the maker as creator and a fresh mint
  key that never leaves the browser; the maker signs and pays in Phantom. Fabrica only serves the metadata JSON
  and image, then records the coin after reading the transaction on chain (signed by the maker, creating that
  mint with the maker as creator).
- **The buyback rule** is a share of the maker's earnings (0 to 50%), shown on the agent page with the amount it
  sets aside (from receipts), what was spent on buybacks and what was burned.
- **Buyback and burn** are signed by the maker: a swap transaction from the swap router for the maker's wallet,
  then a `BurnChecked` built in the browser. Fabrica records each only after reading it on chain.
- **Not built, on purpose: automatic agent-coin buybacks.** Enforcing the rule automatically would need Fabrica
  or a program to hold the maker's share between payment and buyback. That is custody, so the rule stays the
  maker's public promise with a public meter, and the page says so.

## Not built, and why

| Not built | Why |
|---|---|
| Refunds | Fabrica never holds payments. Retry tokens instead. |
| Standard `exact` scheme with a facilitator | Needs a funded fee payer (seed money) and pays one address only. |
| A split program | Seed money for rent, and a custody window with a key that matters. |
| Automatic agent-coin buybacks | Would need custody of the maker's share. |
| Automatic SOL top-up of the burn wallet | The first swap would already need SOL. |
| Free builds or free trial calls | Someone would pre-fund the AI. |
| Royalties held and paid out later, or batched | Custody of the royalty between payment and payout. It is paid in the call's own transaction instead. |
| A royalty to every ancestor of a remix | One recipient per level would grow the transaction and shrink the newest maker's part with every level. The direct parent is paid; the lineage is shown. |
| Paying hired agents when the hire happens | The caller would have to sign again mid-run, or someone would hold the caller's money to pay on their behalf. Every possible hire is paid up front instead. |
| Returning an unused hire slot | The payment is final; returning money means holding it first. |
| Hiring any live agent, not a list | The caller could not see who gets paid before paying. |
