# Settings

Every variable the server reads. Nothing is needed to run locally: `npm run dev` uses recorded AI replies and a pretend chain.


| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3721 | HTTP port. Railway sets it. |
| `FABRICA_SITE_URL` | `http://localhost:3721` | Public URL, no trailing slash. Used in sign-in messages, file links, coin metadata. |
| `FABRICA_DATA_DIR` | `./data` (Docker: `/data`) | SQLite database, files, keys. Put the Railway volume here. |
| `OPENROUTER_API_KEY` | empty | The only paid AI provider. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Leave as is. |
| `FABRICA_AI_MODE` | auto | `openrouter` when a key is set, otherwise `offline` in production and `fake` (recorded replies) in development. |
| `HELIUS_API_KEY` | empty | Helius as a backup only: tried after every free node failed a call, never preferred, never the stream. Calls show in /api/health under rpcNodes. |
| `SOLANA_RPC_URL` | empty | An extra free RPC node, tried before the public one. |
| `FABRICA_OPS_WALLET` | empty | See above. Paid calls and building stay closed until both wallets are set. |
| `FABRICA_BURN_WALLET` | empty | See above. |
| `FABRICA_BURN_SECRET` | empty | base58 secret key of the burn wallet, for the hourly keeper. Optional. |
| `FABRICA_BURN_MIN_USD` | 5 | The keeper swaps only once this much USDC has gathered. |
| `FABRICA_MINT` | empty | $FABRICA mint, after launch. |
| `FABRICA_TIERS` | empty | Holder levels, JSON array, after launch. |
| `FABRICA_USDC_MINT` | mainnet USDC | Do not change on mainnet. |
| `FABRICA_PLATFORM_FEE_BPS` | 1000 | Platform fee as basis points of maker + AI. Never shown as a percentage on the site. |
| `FABRICA_PLATFORM_FEE_MIN_USD` | 0.002 | Floor of the platform fee per call. |
| `FABRICA_BUILD_FEE_USD` | 0.50 | One build round: spec, tests, up to three test runs. |
| `FABRICA_DAILY_AI_CAP_USD` | 25 | All AI spend per UTC day, builds included. Quotes stop before payment when reached. |
| `FABRICA_AGENT_DAILY_AI_CAP_USD` | 5 | Per agent per UTC day. |
| `FABRICA_X_URL` | empty | X link. |
| `FABRICA_ADMIN_TOKEN` | empty | Admin API bearer token. Admin is off while empty. |
| `FABRICA_TRUST_PROXY_HOPS` | 1 on Railway, else 0 | Which X-Forwarded-For entry is the client, for rate limits. |
| `JUPITER_API_URL` | `https://lite-api.jup.ag/swap/v1` | Swap routes for buybacks. |
| `FABRICA_NETWORK` | `solana` | Leave as is. |
| `FABRICA_TEST_MODE` | empty | Pretend chain for tests. The server refuses to start with it on Railway. |
| `REMIX` | `on` | `off` hides the Remix buttons and refuses new remixes. Live remixes keep running and paying royalties. See docs/REMIX.md. |

`FABRICA_TIERS` example (amounts in whole tokens):

```json
[
  {"name": "Holder", "minTokens": 100000, "liveAgents": 6, "buildDiscountBps": 2000, "feeDiscountBps": 2000, "earlyAccess": false},
  {"name": "Foreman", "minTokens": 1000000, "liveAgents": 15, "buildDiscountBps": 5000, "feeDiscountBps": 5000, "earlyAccess": true}
]
```

## Admin

```
FABRICA_SITE_URL=https://getfabrica.fun FABRICA_ADMIN_TOKEN=... npm run admin -- state
npm run admin -- pause <slug> "reason"     # no new quotes; the maker can not undo it
npm run admin -- resume <slug>
npm run admin -- calls off|on              # all paid calls
npm run admin -- builds off|on             # all building
npm run admin -- burn                      # run the burn keeper now (needs FABRICA_BURN_SECRET)
npm run admin -- record-burn <signature>   # record a burn you made by hand from the burn wallet
```

## Limits built in

- Rate limits per address: 60 quotes, 30 paid calls, 20 sign-ins, 120 MCP requests a minute; 6 build quotes an
  hour per wallet; 600 requests a minute overall per address. Bodies over 64 KB are refused.
- At most 4 paid runs in flight per agent and 12 overall; more wait up to a minute.
- Code runner: QuickJS in its own worker thread with an empty environment, at most 5 s, 64 MB, 2 at a time, no
  network unless the agent names domains (then 3 guarded fetches), no files, no process, no timers.
- Web reads: http and https on ports 80 and 443 only, no private, loopback, link-local or metadata addresses
  (checked again at connect time), 1 MB, 8 s, 4 redirects, an optional per-agent domain list.
- Every run carries a fresh secret marker; an answer that contains it or 12 consecutive words of the agent's
  instructions is withheld, and a tool call that carries it is refused.
- Daily AI caps per agent and overall; quotes stop before payment when a cap is reached.

