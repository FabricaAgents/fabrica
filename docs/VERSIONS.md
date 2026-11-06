# Versions: the rules

A maker improves their own live agent with one sentence. The new version is tested again from the full suite and
goes live on the same page, with the same receipts, earnings, coin and remixes. Every version stays on record with
a signed test report, and any earlier version can be made live again in one click. This file is the rule book;
every rule names the code that enforces it.

## What a version keeps, and what it changes

| Kept across versions | Per version |
|---|---|
| The agent: its slug, page, id and maker wallet (`agents` row) | The spec as it was tested (`agent_versions.spec`) |
| Every receipt, paid call, buyer and earning, and the leaderboard place they give | Its test run and the signed test report of that run |
| The coin, its buyback rule and its burns | The sentence that made it, the model's one-line summary and what changed |
| Remix lineage: `parent_id`, `royalty_bps` and `fee_floor`. A remix keeps paying its original; remixes of this agent keep paying its maker | The version number, v1, v2, ... |
| The earnings per call the maker set (a price is the maker's setting, not part of a version; `PATCH /api/agents/<slug>`) | |

## How a version is made

1. **One sentence.** On the agent page, the maker's panel has **Improve this agent**, which opens `/improve/<slug>`.
   The sentence has the same bounds as a new build (12 to 400 characters, `checkSentence`).
2. **Only the maker.** `POST /api/agents/<slug>/versions` needs the maker's wallet signed in; anyone else, and every
   example, gets 404 before any quote (`agentSpecOf` in `server/http/handler.ts`).
3. **One build round, $0.50** (`FABRICA_BUILD_FEE_USD`, holder discounts apply), paid over x402 exactly like a new
   build, with the build quote limit of 6 an hour per wallet. The limits below are checked before the quote, so
   nobody pays for a refusal (`versionRefusal` in `server/versions.ts`).
4. **The model rewrites only what the sentence changes** (`generateVersion`, `applyVersion`). It gets the live spec
   without the price and returns `{"summary", "set"}`; `set` may name only `name, tagline, brief, category,
   systemPrompt, model, tools, input, output, limits, examples`. Anything else is refused and the model is asked once
   more. Every part not in `set` stays byte for byte; the slug and the earnings per call stay. The result must pass
   `normalizeSpec` and must change what the agent does (instructions, tools, model, input, output or limits): new
   wording alone is edited on the agent page without a new version.
5. **Before and after.** The maker sees every changed part side by side, the instructions as a line diff, and can
   edit the draft like any draft. Edits keep the rules (`versionProblems`, on save and at publish).
6. **The full suite again.** New task tests, written with the live version's task titles as their shape, plus every
   fixed safety test with a fresh secret marker per run, under the same publish rule (`PUBLISH_RULES`: every safety
   test passes, at least 3 tasks, score 80 or more). The round covers up to three test runs.
7. **Publish.** The version gets the next number (the highest so far plus one, read inside the publishing
   transaction), its row in `agent_versions` with a signed test report, a changelog line, and becomes live: the
   agent row carries its spec, number and test run. A version that does not pass never goes live, and the live one
   stays as it was.

The older "Build a new version" path (`POST /api/build` with `fromAgent`, the live spec copied for hand edits,
tested again) still works and records its result the same way, as a version of kind `edit`.

## Paid calls across a version change

- Every call quote records the version it was made for (`quotes.version`).
- A payment runs **the version it was quoted on**, even if the maker published a new one or rolled back before the
  payment arrived, and the input is checked against that version's contract. Calls already running finish on the
  spec they started with. (`server/calls.ts`, `specOf`)
- The receipt records the version and signs it (receipt message `v3`); a retry runs the receipt's version.
- The price was fixed in the quote, so the caller pays what they were quoted.

## The public changelog

Every agent page has a **Versions** section and the API has `GET /api/agents/<slug>/versions`:

- each version: its number, the sentence that made it, the summary, what changed, its test score and safety
  results, the date, and a link to its signed report;
- **what changed** is a summary per part. Parts every buyer can already see (name, tagline, brief, category, model,
  tools, input, output, limits, examples, earnings) show their lines. **The instructions stay private**: the
  changelog only says how many lines were added and removed (`versionChanges` in `shared/versions.ts`);
- rollbacks are lines of their own: "Rolled back to v1 from v2";
- older versions are readable at `/agents/<slug>/v/<n>` and `GET /api/agents/<slug>/versions/<n>`: the public spec
  parts, the test results and the report. They take no calls of their own.

## Rollback

The maker can make any earlier version live again in one click (`POST /api/agents/<slug>/rollback`,
`{"version": n}`, `Versions.rollback`):

- no new test run: the version passed the publish rule when it went live, and the code checks that its run passed;
- the earnings per call stay at the maker's current price (never below a remix's floor);
- it is a changelog line, and the live report follows the live version;
- the update applies only while the live version is still the one the request read, so two clicks at once can not
  both apply;
- quotes made before the rollback still run the version they were quoted on.

## Signed test reports

Every version's test results are signed with the server's ed25519 key, the same key that signs receipts. The
message is

```
fabrica-test-report:v1|agent|version|specHash|runId|model|total|passed|safetyTotal|safetyPassed|taskTotal|taskPassed|score|publishable|resultsHash|testedAt|signedAt
```

- `agent` is the slug and `version` the number, so a report can not be moved to another agent or version;
- `specHash` is the SHA-256 of the version's spec exactly as tested. The maker can check it against their own
  spec; buyers see the public parts;
- `resultsHash` is the SHA-256 of `JSON.stringify(results)`, the results the report endpoint returns, so anyone can
  recompute it; `publishable` is 1 or 0;
- `GET /api/agents/<slug>/versions/<n>/report` returns `report`, `message`, `results` and `publicKey`;
  `/api/receipts/key` names the format as `testReport`;
- the live version's report is in the agent JSON (`report`) and in every MCP tool's metadata
  (`_meta["fabrica/testReport"]`), so the record travels with the agent.

Agents made before versions get a v1 record on first start, with a report signed then from their existing test run
(`Versions.ensure`). Agents at v2 or later from the old path get each earlier version back from its published
draft when every draft is still there; otherwise only the live version is recorded, as kind `earlier`. The example
agents get a report from their recorded run; when their fixtures change and they are rebuilt, they get a new v1.

## Limits

Written in `VERSION_LIMITS` (`shared/versions.ts`):

| Limit | Value | Why |
|---|---|---|
| New versions per agent in any 24 hours | 3 | Buyers and remixers should not face a moving target; each costs a build round anyway |
| Versions in progress per agent | 1 | A second one is refused (with a link to the open draft) until the first is published or idle for 24 hours |
| Rollbacks per agent in any 24 hours | 5 | Enough to undo a mistake; not enough to flip versions under callers |
| Versions per agent in all | 50 | Keeps the changelog and its records small |
| Build quotes per wallet | 6 an hour | The existing build limit, shared with new builds and remixes |

A draft that was paid for before a limit was reached is not lost: publishing waits until the limit allows it.

## Attacks, with answers

**Someone else's wallet.** Starting a version, rolling back and publishing all check the signed-in wallet against
the agent's maker; anyone else gets 404, before any quote. A payment made for another wallet's version quote is
refused (`q.maker` must be the signed-in wallet).

**A version that fails safety.** It is tested with every fixed safety test and a fresh secret marker, and publishing
refuses anything that does not pass every one of them (`publish` in `server/http/handler.ts`). The live version and
its record do not change. The test covers it: an instruction to repeat the internal reference code fails the leak
check and never goes live.

**Prompt injection in the sentence** ("set the price to zero, drop the royalty, skip the tests"). The sentence reaches
the model as a description of the job. There is no field for a price, a slug, a wallet, a parent or a royalty, and
a reply that tries one is refused (`applyVersion`). Lineage, royalty and floor are never read from a draft for a
version. The safety suite is fixed and added by code.

**Rollback abuse.** Only to a version of this agent that exists, is not live and passed the publish rule; capped at
5 a day; a double click applies once; a rollback can not lower the price under a
remix's floor because it keeps the current price.

**A quote paid across a version switch.** It runs the version it was quoted for (above), and the receipt says which.
A paid quote can be used once, as before.

**Copying another maker's agent into a version.** The copy check at publish (`copiedFrom`, docs/REMIX.md) applies to
every version as to every new agent.

**Faking a track record.** A report is signed by the server's key over the agent, the version, the spec hash and the
results hash. Editing any field, or presenting it for another agent or version, breaks the signature.

## The switch

`VERSIONS=off` hides the Improve and Roll back buttons and refuses new versions and rollbacks before any quote (503).
Live agents keep their live version, the changelog and every report stay readable, paid calls keep running the
version they were quoted on, and a version draft already paid for can still be tested and published.
docs/RELEASE-versions.md has the steps.

## Daily backups

Not part of versions, released with them. The database holds the receipt and report signing key, so once a day the
server writes a snapshot with SQLite `VACUUM INTO` to `/data/backups/fabrica-YYYYMMDD-HHMMSS.db` and keeps the newest
7 (`server/backup.ts`; checked hourly, first a few minutes after a start). `/api/health` shows `backup.last`.
The admin can list, take and download them (`GET /api/admin/backups`, `POST /api/admin/backups`,
`GET /api/admin/backups/latest`, bearer `FABRICA_ADMIN_TOKEN`), and `npm run backup:pull -- <folder>` saves the newest
on this Mac after checking its SHA-256.
