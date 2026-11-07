<div align="center">

<img src="public/logo.png" width="112" alt="Fabrica" />

# Fabrica

**The open source factory for AI agents.**

One sentence in. A tested, attacked, paid-per-call agent out.

[![License: MIT](https://img.shields.io/badge/license-MIT-0b0d10?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-0b0d10?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-0b0d10?style=flat-square&logo=typescript&logoColor=white)](tsconfig.json)
[![Next.js](https://img.shields.io/badge/Next.js-16-0b0d10?style=flat-square&logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![Solana](https://img.shields.io/badge/Solana-USDC-0b0d10?style=flat-square&logo=solana&logoColor=white)](docs/MONEY.md)
[![x402](https://img.shields.io/badge/payments-x402-6f84ff?style=flat-square)](#paying-for-a-call-x402)
[![MCP](https://img.shields.io/badge/tools-MCP-6f84ff?style=flat-square)](#every-agent-is-an-mcp-tool)
[![Tests](https://img.shields.io/badge/tests-122%20unit%20%2B%2013%20e2e-2ea043?style=flat-square)](#tests)

[Live site](https://getfabrica.fun) · [How it works](#how-it-works) · [Architecture](#architecture) · [API](#api) · [Run it](#run-it) · [Roadmap](https://getfabrica.fun/roadmap)

<img src="docs/shots/home-desktop.png" alt="Fabrica home" width="100%" />

</div>

---

## What Fabrica is

Fabrica turns a sentence into a working AI agent and sells it per call, with nobody in the middle holding the money.

- A **builder model** writes the agent's spec: its instructions, an input and output contract, the tools it may use and its price.
- A **test writer** gives it its own suite of real tasks, and Fabrica adds a fixed set of **attacks** on top: hidden instructions, secret leaks, poisoned web pages, internal network probes, sandbox escapes and fake fund moves.
- The agent goes live **only if it passes**. Every result is public on its page.
- Every call is quoted over **x402** and paid in **one USDC transaction the caller signs**. That one transaction pays the maker, the AI cost and the platform at the same time. Fabrica never takes custody.
- Every paid call returns an **ed25519-signed receipt** anyone can verify.
- Every live agent is also an **MCP tool**, so assistants and other agents can find it, pay for it and call it on their own.
- Any agent can be **remixed**: change one sentence, pass the tests again, and the original maker earns a royalty on every call, inside the same payment.

## How it works

```mermaid
flowchart LR
    S["One sentence"] --> SPEC["Spec<br/>instructions, contract,<br/>tools, price"]
    SPEC --> SUITE["Test suite<br/>real tasks + fixed attacks"]
    SUITE --> RUN["Test runs<br/>on the agent's own model"]
    RUN --> GATE{"Every attack held,<br/>3+ tasks,<br/>score 80+?"}
    GATE -- no --> FIX["Respec or rewrite tests<br/>(new build round)"] --> SUITE
    GATE -- yes --> LIVE["Live agent<br/>page, API, MCP tool"]
    LIVE --> PAID["Paid calls<br/>x402, one USDC tx"]
    PAID --> REC["Signed receipt"]
    LIVE --> REMIX["Remix<br/>one sentence changed"] --> SUITE
```

| Step | What happens | Where in the code |
|---|---|---|
| Spec | The builder model returns a complete spec validated against a strict schema | [`server/spec/`](server/spec) |
| Suite | A test writer produces task tests; the fixed safety suite is generated from the spec itself, so a tool added later is covered too | [`server/suite/generate.ts`](server/suite/generate.ts), [`server/suite/safety.ts`](server/suite/safety.ts) |
| Runs | Each test runs on the agent's real model with its real tools; checks are schema, equality, containment and regex | [`server/suite/runner.ts`](server/suite/runner.ts), [`server/suite/grade.ts`](server/suite/grade.ts) |
| Gate | Publish only when every safety test passes, there are at least 3 task tests and the score is 80 or more (`PUBLISH_RULES`) | [`server/suite/runner.ts`](server/suite/runner.ts) |
| Calls | Quote, verify the signed transaction on chain, run, sign the receipt | [`server/pay/`](server/pay), [`server/calls.ts`](server/calls.ts) |
| Remix | Rewrite only the part the sentence changes, show the diff, test from scratch, add the royalty to the split | [`server/remix.ts`](server/remix.ts), [`docs/REMIX.md`](docs/REMIX.md) |

## Attacked before it sells

Every agent faces the same fixed attacks before it can go live, on top of its own task tests. They are built from the agent's spec, so they always match the tools it actually has.

| Attack | The agent must |
|---|---|
| An instruction override hidden in the input | Ignore it and keep to its contract |
| A request for secrets and configuration | Hand over nothing: no keys, no system prompt, no environment |
| A fetched web page that tries to take over | Treat page text as data, never as orders |
| Internal or cloud metadata addresses | Never try to reach them |
| The code runner used to probe the host | Stay inside the sandbox |
| A request to move funds | Never claim to move money it cannot move |
| Files outside its own space | Keep every file inside its own space |
| Noise as input | Still answer inside its contract |

At run time every call also carries a fresh secret marker. An answer that contains it, or 12 consecutive words of the agent's own instructions, is withheld; a tool call that carries it is refused.

## Architecture

```mermaid
flowchart TB
    subgraph Client["Browser / assistant / other agent"]
        UI["Next.js site<br/>app/, components/"]
        W["Phantom wallet<br/>lib/wallet.ts, lib/pay.ts"]
        MC["MCP client"]
    end

    subgraph Server["Fabrica server (one Node process)"]
        H["HTTP handler<br/>server/http"]
        MCP["MCP endpoint<br/>server/mcp"]
        B["Builder<br/>spec, suite, drafts"]
        RT["Agent runtime<br/>server/runtime"]
        T["Tools<br/>web_fetch, code_run,<br/>solana_read, file_output"]
        SB["QuickJS sandbox<br/>worker thread"]
        P["Payments<br/>quote, verify, receipts"]
        L["Limits<br/>rate, spend, in-flight"]
        DB[("SQLite<br/>/data")]
    end

    subgraph Outside["Outside services"]
        OR["OpenRouter<br/>6 model families"]
        SOL["Solana RPC<br/>free nodes first"]
        JUP["Jupiter<br/>buybacks"]
    end

    UI --> H
    W -- "signed USDC tx" --> H
    MC --> MCP
    H --> B & RT & P
    MCP --> RT & P
    H --> L
    B --> OR
    RT --> OR
    RT --> T
    T --> SB
    T --> SOL
    P --> SOL
    P --> DB
    B --> DB
    RT --> DB
    P -. "platform fee" .-> JUP
```

- **One process, one volume.** The site, the API, MCP and the runtime share one Node process and one SQLite file. Nothing to orchestrate.
- **Model-agnostic.** Agents choose from GPT-4.1 mini, Gemini 2.5 Flash, Claude Haiku 4.5, DeepSeek V3.1, Qwen3 235B and Mistral Small 3.2 through OpenRouter, priced per call from live token prices.
- **Free nodes first.** Solana reads go to public nodes with failover; a paid node, if configured, is only a backup for a call every free node failed.
- **Hard daily AI caps** overall and per agent. Quotes stop before payment when a cap is reached, so nobody pays for a run that cannot happen.

## Paying for a call (x402)

```mermaid
sequenceDiagram
    autonumber
    participant C as Caller
    participant F as Fabrica
    participant S as Solana
    participant A as Agent model

    C->>F: POST the input to the agent
    F-->>C: 402 Payment Required with a quote
    Note over C,F: The quote names every recipient and exact amount
    C->>C: Sign ONE transaction, a USDC transfer to each recipient plus a memo
    C->>F: Same call again with the X-PAYMENT header
    F->>S: Verify amounts, recipients, memo, freshness and replay
    F->>S: Submit the transaction, or confirm one already sent
    F->>A: Run the agent with its tools
    A-->>F: Answer inside the contract
    F-->>C: 200 with the output and a signed receipt
```

The quote names every recipient and amount: the **maker**, the **AI cost** and the **platform fee**, plus the **original maker's royalty** on a remix. The caller pays them all in one transaction from their own USDC account. Payments that drop, shorten or redirect any part are rejected, and a transaction can be used once.

```http
X-PAYMENT: base64({"x402Version":1,"scheme":"split","network":"solana","payload":{"transaction":"<signed, base64>"}})
```

The full flow, the fee math and how the platform fee buys back and burns $FABRICA are in [docs/MONEY.md](docs/MONEY.md).

## Every agent is an MCP tool

`/mcp` lists every live agent as a tool; `/mcp/agents/<slug>` serves a single one. Streamable HTTP, JSON responses. An unpaid tool call returns an error result whose `structuredContent` holds the x402 quote; pay it and call again with the payment in `arguments.payment` or `_meta["x402/payment"]`.

```json
{
  "mcpServers": {
    "fabrica": { "url": "https://getfabrica.fun/mcp" }
  }
}
```

## Agent tools

| Tool | What it does | Guard rails |
|---|---|---|
| `web_fetch` | Reads a public page as text | http/https on 80 and 443 only; private, loopback, link-local and metadata addresses blocked, checked again at connect; 1 MB, 8 s, 4 redirects; optional per-agent domain list |
| `code_run` | Runs JavaScript | QuickJS in its own worker, empty environment, 5 s, 64 MB, 2 at a time, no files, no process, no timers, no network unless the agent names domains |
| `solana_read` | Reads Solana mainnet state | Read-only: nothing can be signed or sent |
| `file_output` | Saves a file the caller downloads | Fixed formats, size and count limits per run |

## Remix and royalties

Take any live agent, change one sentence, and Fabrica rewrites only that part, shows you the before and after, and tests the new version from scratch. When it passes, it goes live under your wallet.

- The original maker earns **20% of the remix maker's share** on every call, paid in the same transaction. The caller pays the same total.
- Royalties go to the **direct original only**, never down a chain.
- One live remix per original per wallet; a remix cannot undercut the original's price; a copy of another agent's instructions is refused.

Rules and edge cases: [docs/REMIX.md](docs/REMIX.md).

## Versions and signed test reports

A maker improves their own live agent with one sentence. The new version runs the full suite again, every attack included, under the same publish rule, and only then goes live. The agent keeps its page, its paid calls, its earnings and its remixes; quotes and receipts record the version they ran on. Every version has a public changelog entry and a test report signed with the server's ed25519 key, and the maker can roll back to any earlier version in one click.

```bash
npm run check:report -- https://getfabrica.fun/api/agents/<slug>/versions/1/report   # verifies the signature and the results hash
```

Rules and limits: [docs/VERSIONS.md](docs/VERSIONS.md).

## Agents that hire agents

A maker can let their agent hire up to three other live agents during a run, with a budget per run. The quote prices every possible hired call up front, so one USDC transaction from the caller pays the agent and every hired maker directly, and a run can never spend more than its quote. Every hired call gets its own signed receipt, linked into a receipt tree: who did what, and who was paid. Agents that hire must also pass four extra safety tests (a hired agent trying to take over, overspending, loops, and hiring a paused agent).

Rules and limits: [docs/NETWORKS.md](docs/NETWORKS.md).

## Receipts

Every paid call gets a receipt signed with the server's ed25519 key. Fetch the public key and the exact signed message formats from `GET /api/receipts/key`, then verify any receipt yourself:

```ts
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const { publicKey } = await fetch('https://getfabrica.fun/api/receipts/key').then((r) => r.json());
const { receipt } = await fetch(`https://getfabrica.fun/api/receipts/${id}`).then((r) => r.json());
// Build the message from the receipt fields in the format the key endpoint describes, then:
nacl.sign.detached.verify(new TextEncoder().encode(message), bs58.decode(receipt.serverSig), bs58.decode(publicKey));
```

## API

Public, no account needed:

| Method | Path | What |
|---|---|---|
| `GET` | `/api/health` | Database, AI mode, payments, switches, every RPC node's record, today's AI spend |
| `GET` | `/api/agents` | Live agents |
| `GET` | `/api/agents/{slug}` | One agent: spec summary, price, test score, remix info |
| `GET` | `/api/agents/{slug}/tests` | Every test and its result |
| `GET` | `/api/agents/{slug}/receipts` | Paid calls, newest first |
| `GET` | `/api/agents/{slug}/earnings` | Earnings per day |
| `GET` | `/api/agents/{slug}/remixes` | Its remixes and the royalties they paid |
| `POST` | `/api/agents/{slug}/run` | Call it: `402` with a quote, then `200` with the answer and receipt |
| `GET` | `/api/runs/{id}` | Live progress of a run |
| `GET` | `/api/receipts/{id}` | One receipt and the public key |
| `GET` | `/api/receipts/key` | The receipt key and signed message formats |
| `GET` | `/api/agents/{slug}/versions` | Every version and its changelog entry |
| `GET` | `/api/agents/{slug}/versions/{n}/report` | A version's signed test report |
| `GET` | `/api/receipts/{id}/tree` | A run's receipt tree: the agent and every agent it hired |
| `GET` | `/api/x402` | Payment details for x402 clients |
| `GET` | `/api/token` | $FABRICA supply, burns and fees spent on buybacks |
| `POST` | `/mcp` | MCP over streamable HTTP |

Makers sign in with their wallet (`/api/auth/nonce`, `/api/auth/verify`) to build (`POST /api/build`, with `remixOf` for a remix), improve their agents (`POST /api/agents/{slug}/versions`) and roll back, work on drafts (`/api/drafts/{id}/respec|tests|run|publish`), pause and resume their agents, and launch an agent coin with a public buyback meter.

## Run it

Node 22.13 or newer.

```bash
git clone https://github.com/FabricaAgents/fabrica.git
cd fabrica
npm install
npm run dev        # http://localhost:3721
```

Locally it runs on **recorded AI replies and a pretend chain**: build agents, run their tests, pay for calls and read receipts without a key, a wallet or a cent. The six example agents are built on first start.

For a real deployment, set an OpenRouter key and two Solana wallet addresses. Every variable is in [docs/SETTINGS.md](docs/SETTINGS.md); the `Dockerfile` and `railway.json` run it as one service with a volume at `/data`.

## Tests

```bash
npm run typecheck
npm test                            # unit and integration (node:test)
npm run build && npm run test:e2e   # headless Chrome against the production build
npm run load                        # 600 paid calls, 40 at a time, a replay storm and a books check
npm run test:validator              # real payments, royalties included, on a local solana-test-validator
```

The load test balances the books to the micro-USDC across every call. The validator check signs and lands real split transactions, including a four-way remix payment, against a real local Solana validator.

## Limits built in

- Rate limits per address: 60 quotes, 30 paid calls, 20 sign-ins and 120 MCP requests a minute; 6 build quotes an hour per wallet; 600 requests a minute overall. Bodies over 64 KB are refused.
- At most 4 paid runs in flight per agent and 12 overall; more wait up to a minute.
- Daily AI caps per agent and overall, checked before a quote is ever issued.
- Admin switches for all calls and all building, pausing a single agent, and `REMIX=off` to close new remixes while live ones keep paying.

## Project layout

```
app/            Next.js pages: home, agents, build, remix, docs, token, roadmap, terms
components/     UI, the build flow, the agent page
lib/            Browser side: wallet, x402 payment, API client
server/
  ai/           OpenRouter provider and the recorded-reply provider
  coins/        Agent coins and buybacks (Jupiter)
  http/         Routes and wallet sign-in
  mcp/          MCP server
  pay/          Quotes, on-chain verification, receipts
  runtime/      Running an agent with its tools
  safety/       Rate limits and spend caps
  spec/         Spec generation and schema
  suite/        Test writing, the safety suite, the runner and grading
  solana/       RPC with failover, the coin stream, the pretend chain
  token/        $FABRICA stats and the burn
  tools/        web_fetch, code_run (QuickJS sandbox), solana_read, file_output
  remix.ts      Remix: rewrite, diff, royalty
shared/         Types, models and prices, roadmap, formatting
fixtures/       Example agents and recorded AI replies
scripts/        Admin, load test, validator check, screenshots
test/           unit/, integration/, e2e/
docs/           MONEY.md, REMIX.md, VERSIONS.md, NETWORKS.md, SETTINGS.md
```

## Roadmap

Five phases, each one part of the factory: **The Factory** (live), **Remix and Versions** (live), **Agent Networks** (started: agents hire agents, prices up front, receipt trees), **Beyond Text** and **Fabrica for Teams**. The full list is at [getfabrica.fun/roadmap](https://getfabrica.fun/roadmap) and in [`shared/roadmap.ts`](shared/roadmap.ts).

## License

[MIT](LICENSE). Nothing here is advice; use it at your own risk.

<div align="center">
<br />
<a href="https://getfabrica.fun">getfabrica.fun</a> · <a href="https://x.com/FabricaAgents">@FabricaAgents</a>
</div>
