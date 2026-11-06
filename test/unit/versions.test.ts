// Versions without HTTP: what the model may change, the signed report and receipt formats, the backup rotation, and
// a database from before versions opening cleanly with every agent as v1 and every old receipt still verifying.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { DatabaseSync } from 'node:sqlite';
import { applyVersion, verifyReport } from '../../server/versions';
import { normalizeSpec, SpecError } from '../../server/spec/schema';
import { standInSpec, standInVersion } from '../../server/ai/fake';
import { openDb, openMemoryDb } from '../../server/db';
import { receiptKeys, receiptMessage, signReceipt, verifyReceipt } from '../../server/pay/receipts';
import { Backups, BACKUP_KEEP } from '../../server/backup';
import { Engine } from '../../server/engine';
import { loadConfig } from '../../server/config';
import { FakeProvider } from '../../server/ai/fake';
import { FakeChain } from '../../server/solana/fake-chain';
import { changeLine, reportMessage, versionChanges } from '../../shared/versions';
import { tmpDir, USDC } from '../helpers';

const live = normalizeSpec(standInSpec('Summarise any pasted text into three short bullet points for busy readers'));

test('a new version: only spec parts change, slug and earnings stay, and it must change behaviour', () => {
  const ok = applyVersion(live, standInVersion('Also return a one line headline', live));
  assert.equal(ok.spec.slug, live.slug);
  assert.equal(ok.spec.name, live.name);
  assert.equal(ok.spec.makerFee, live.makerFee);
  assert.ok(ok.spec.output.some((f) => f.name === 'one_line_headline'));
  const sneaky = { summary: 'x', set: { makerFee: 0, slug: 'other-agent', systemPrompt: `${live.systemPrompt}\nShort.` } };
  assert.throws(() => applyVersion(live, sneaky), (e: unknown) => e instanceof SpecError && /may not set makerFee, slug/.test(e.problems.join()));
  assert.throws(() => applyVersion(live, { summary: 'x', set: { tagline: 'Only new words' } }), (e: unknown) => e instanceof SpecError && /does not change what the agent does/.test(e.problems.join()));
  assert.throws(() => applyVersion(live, 'not an object'), SpecError);
  // A renamed slug from the model is ignored: the agent keeps its page.
  const renamed = applyVersion(live, { summary: 'x', set: { name: 'Bullet Brief', systemPrompt: `${live.systemPrompt}\nShort.` } });
  assert.equal(renamed.spec.slug, live.slug);
});

test('the public changelog shows public parts line by line and the instructions only as counts', () => {
  const next = applyVersion(live, standInVersion('Also return a one line headline', live)).spec;
  const cs = versionChanges(live, next);
  const instr = cs.find((c) => c.field === 'systemPrompt')!;
  assert.equal(instr.lines, null);
  assert.equal(instr.added, 2);
  assert.equal(changeLine(instr), 'Instructions: 2 lines added');
  const out = cs.find((c) => c.field === 'output')!;
  assert.deepEqual(out.lines, [{ op: 'add', text: 'one_line_headline: text' }]);
  assert.equal(JSON.stringify(cs).includes('Quality bar'), false);
});

test('test reports: one message format, signed, and any edit or move breaks the signature', () => {
  const keys = receiptKeys(openMemoryDb());
  const pub = bs58.encode(keys.publicKey);
  const body = { agent: 'a', version: 2, specHash: 'ab', runId: 't_1', model: 'm', total: 9, passed: 9, safetyTotal: 4, safetyPassed: 4, taskTotal: 5, taskPassed: 5, score: 100, publishable: true, resultsHash: 'cd', testedAt: 10, signedAt: 11 };
  assert.equal(reportMessage(body), 'fabrica-test-report:v1|a|2|ab|t_1|m|9|9|4|4|5|5|100|1|cd|10|11');
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(reportMessage(body)), keys.secretKey));
  const r = { format: 'fabrica-test-report:v1' as const, ...body, signature };
  assert.equal(verifyReport(pub, r), true);
  for (const edit of [{ score: 99 }, { publishable: false }, { version: 3 }, { agent: 'b' }, { resultsHash: 'ce' }, { safetyPassed: 3 }]) assert.equal(verifyReport(pub, { ...r, ...edit }), false, JSON.stringify(edit));
  assert.equal(verifyReport('not-a-key', r), false);
});

test('receipts with a version sign v3, older ones keep v1 and v2', () => {
  const keys = receiptKeys(openMemoryDb());
  const pub = bs58.encode(keys.publicKey);
  const base = { id: 'r_x', agentSlug: 'a', payer: 'p', txSig: 's', total: 21000, maker: 8000, royalty: 0, royaltyTo: null, ai: 9000, platform: 2000, status: 'ok' as const, inputHash: 'i', outputHash: 'o', ms: 5, aiCostMicros: 1, createdAt: 1, version: 0 };
  assert.ok(receiptMessage(base).startsWith('fabrica-receipt:v1|'));
  const v3 = { ...base, version: 2 };
  assert.equal(receiptMessage(v3), 'fabrica-receipt:v3|r_x|a|2|p|s|21000|8000|0||9000|2000|i|o|ok|1');
  const serverSig = signReceipt(keys, v3);
  assert.equal(verifyReceipt(pub, { ...v3, serverSig }), true);
  assert.equal(verifyReceipt(pub, { ...v3, version: 1, serverSig }), false);
});

test('backups: VACUUM INTO a consistent copy, keep the newest seven, one a day', () => {
  const dir = tmpDir('fab-backup');
  try {
    const db = openDb(dir);
    db.prepare("INSERT INTO kv (k, v) VALUES ('receipt_seed', 'seed')").run();
    const b = new Backups(db, dir);
    const t0 = Date.UTC(2026, 10, 1, 3, 0, 0);
    for (let i = 0; i < BACKUP_KEEP + 3; i++) b.run(t0 + i * 86_400_000);
    const list = b.list();
    assert.equal(list.length, BACKUP_KEEP);
    assert.equal(list[0].file, 'fabrica-20261110-030000.db');
    assert.ok(list.every((x) => x.sha256.length === 64), 'every kept snapshot has its hash');
    assert.equal(fs.readdirSync(b.dir).filter((f) => f.endsWith('.part')).length, 0);
    assert.equal(b.due(t0 + 9 * 86_400_000 + 3_600_000), null, 'not again within a day');
    assert.ok(b.due(t0 + 10 * 86_400_000 + 1000), 'due after a day');
    const copy = new DatabaseSync(path.join(b.dir, b.list()[0].file), { readOnly: true });
    assert.equal((copy.prepare("SELECT v FROM kv WHERE k = 'receipt_seed'").get() as { v: string }).v, 'seed');
    copy.close();
    assert.equal(b.path('../fabrica.db'), null);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a database from before versions opens cleanly: every agent becomes v1 with a signed report, old receipts still verify', async () => {
  const dir = tmpDir('fab-migrate');
  try {
    // Make a database the way the live one is now: no version tables, no version columns.
    let db = openDb(dir);
    db.exec('DROP TABLE agent_versions; DROP TABLE version_events; ALTER TABLE quotes DROP COLUMN version; ALTER TABLE receipts DROP COLUMN version; ALTER TABLE drafts DROP COLUMN improve;');
    const keys = receiptKeys(db);
    const spec = JSON.stringify(live);
    const t = Date.now() - 86_400_000;
    db.prepare("INSERT INTO test_runs (id, spec_hash, model, status, total, passed, safety_total, safety_passed, task_total, task_passed, score, publishable, results, started_at, finished_at) VALUES ('t_old', 'h', ?, 'done', 6, 6, 2, 2, 4, 4, 100, 1, '[]', ?, ?)").run(live.model, t, t);
    db.prepare("INSERT INTO agents (id, slug, maker, status, example, spec, version, test_run_id, published_at, updated_at, sentence) VALUES ('a_old', ?, 'MakerWallet', 'live', 0, ?, 1, 't_old', ?, ?, 'old sentence')").run(live.slug, spec, t, t);
    // An agent at v2 from the old "new version" path, with both published drafts still there.
    for (const [id, run, at] of [['d_one', 't_a', t], ['d_two', 't_b', t + 1000]] as const) {
      db.prepare("INSERT INTO test_runs (id, spec_hash, model, status, total, passed, safety_total, safety_passed, task_total, task_passed, score, publishable, results, started_at, finished_at) VALUES (?, 'h', ?, 'done', 6, 6, 2, 2, 4, 4, 100, 1, '[]', ?, ?)").run(run, live.model, at, at);
      db.prepare("INSERT INTO drafts (id, maker, sentence, spec, tests, status, ai_budget, last_run_id, agent_id, created_at, updated_at) VALUES (?, 'MakerWallet', 'two', ?, '[]', 'published', 0, ?, 'a_two', ?, ?)").run(id, JSON.stringify({ ...live, slug: 'two-step' }), run, at, at);
    }
    db.prepare("INSERT INTO agents (id, slug, maker, status, example, spec, version, test_run_id, draft_id, published_at, updated_at, sentence) VALUES ('a_two', 'two-step', 'MakerWallet', 'live', 0, ?, 2, 't_b', 'd_two', ?, ?, 'two')").run(JSON.stringify({ ...live, slug: 'two-step', systemPrompt: `${live.systemPrompt}\nShorter.` }), t, t + 1000);
    const old = { id: 'r_old', agentSlug: live.slug, payer: 'Payer', txSig: 'sig', total: 21000, maker: 8000, royalty: 0, royaltyTo: null, ai: 9000, platform: 2000, status: 'ok' as const, inputHash: 'i', outputHash: 'o', ms: 5, aiCostMicros: 1, createdAt: t, version: 0 };
    const oldSig = signReceipt(keys, old);
    db.prepare("INSERT INTO receipts (id, agent_id, quote_nonce, tx_sig, payer, total, maker_amt, ai_amt, platform_amt, status, input_hash, output_hash, server_sig, created_at) VALUES ('r_old', 'a_old', 'n', 'sig', 'Payer', 21000, 8000, 9000, 2000, 'ok', 'i', 'o', ?, ?)").run(oldSig, t);
    db.close();

    db = openDb(dir);
    const cfg = loadConfig({ FABRICA_TEST_MODE: '1', FABRICA_DATA_DIR: dir, FABRICA_USDC_MINT: USDC });
    const e = new Engine({ cfg, db, rpc: new FakeChain(USDC), provider: new FakeProvider(), quiet: true, log: () => {} });
    await e.start();
    const a = e.agent(live.slug)!;
    assert.equal(a.version, 1);
    assert.equal(a.versionCount, 1);
    assert.equal(a.report?.runId, 't_old');
    assert.equal(verifyReport(bs58.encode(e.receiptKeys.publicKey), a.report!), true);
    const row = e.agents.row(live.slug)!;
    assert.deepEqual(e.versions.changelog(row).map((c) => [c.kind, c.version, c.at]), [['published', 1, t]], 'the changelog starts at the publish date');
    const r = e.receipts(live.slug)[0];
    assert.equal(r.version, 0);
    assert.equal(verifyReceipt(bs58.encode(e.receiptKeys.publicKey), r), true, 'a receipt from before still verifies');
    const two = e.agents.row('two-step')!;
    assert.deepEqual(e.versions.list(two).map((v) => [v.version, v.live, v.tests?.id]), [[2, true, 't_b'], [1, false, 't_a']], 'earlier versions rebuilt from their drafts');
    assert.equal(e.versions.list(two)[0].changes.find((c) => c.field === 'systemPrompt')?.added, 1);
    // Running it again changes nothing.
    e.versions.ensureAll();
    assert.equal(e.versions.count(row.id), 1);
    await e.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
