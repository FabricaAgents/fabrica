import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Keypair } from '@solana/web3.js';
import { applyRemix, generateRemix, overlap, COPY_THRESHOLD, remixProblems } from '../../server/remix';
import { FakeProvider, standInSpec, type Brain } from '../../server/ai/fake';
import { normalizeSpec, SpecError } from '../../server/spec/schema';
import { priceFor } from '../../server/pay/price';
import { lineDiff, REMIX_ROYALTY_BPS, royaltyOf, specChanges } from '../../shared/remix';
import { buildPayment } from '../../shared/pay';
import { checkConfirmed, checkRawTransaction, PaymentError } from '../../server/pay/verify';
import { FakeChain } from '../../server/solana/fake-chain';
import { receiptKeys, receiptMessage, signReceipt, verifyReceipt } from '../../server/pay/receipts';
import { openDb, openMemoryDb } from '../../server/db';
import { tmpDir } from '../helpers';
import bs58 from 'bs58';
import type { PaymentRequirements } from '../../shared/types';
import { releaseNotes } from '../../fixtures/examples/release-notes';

const original = () => normalizeSpec({ ...standInSpec('Summarise meeting notes into decisions and action items'), name: 'Meeting Digest', makerFee: 10_000 });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PaymentError) return e.code;
    if (e instanceof SpecError) return e.problems.join('; ');
    throw e;
  }
  return 'ok';
};

test('a remix changes only what its reply sets; the rest stays byte for byte and the earnings stay the original', () => {
  const o = original();
  const out = [...o.output, { name: 'email_subject', type: 'string', description: 'Subject of the follow-up email', required: true }];
  const { spec, summary } = applyRemix(o, { summary: 'Adds an email subject.', set: { name: 'Meeting Follow-up', output: out, systemPrompt: `${o.systemPrompt}\n5. Write a subject line for the follow-up email.` } });
  assert.equal(spec.name, 'Meeting Follow-up');
  assert.equal(spec.slug, 'meeting-follow-up');
  assert.deepEqual(spec.input, o.input);
  assert.deepEqual(spec.tools, o.tools);
  assert.equal(spec.brief, o.brief);
  assert.equal(spec.model, o.model);
  assert.equal(spec.makerFee, o.makerFee);
  assert.equal(summary, 'Adds an email subject.');
  const changed = specChanges(o, spec).map((c) => c.field);
  assert.deepEqual(changed, ['name', 'systemPrompt', 'output']);
});

test('a remix reply can not set money, slugs or anything outside the spec parts, keep the name, or change nothing', () => {
  const o = original();
  assert.match(code(() => applyRemix(o, { set: { name: 'Cheaper Digest', makerFee: 0, systemPrompt: `${o.systemPrompt} Short.` } })), /may not set makerFee/);
  assert.match(code(() => applyRemix(o, { set: { name: 'Digest X', royaltyBps: 0, parent: null, wallet: 'x', systemPrompt: `${o.systemPrompt} Short.` } })), /may not set royaltyBps, parent, wallet/);
  assert.match(code(() => applyRemix(o, { set: { name: ' meeting  DIGEST ', systemPrompt: `${o.systemPrompt} Short.` } })), /own name/);
  assert.match(code(() => applyRemix(o, { set: { name: 'Meeting Digest Pro', tagline: 'New words only' } })), /does not change what the agent does/);
  assert.match(code(() => applyRemix(o, { set: { name: 'Bad Tools', tools: { shell: {} } } })), /unknown tool/);
  assert.match(code(() => applyRemix(o, 'no')), /not a JSON object/);
  assert.match(code(() => applyRemix(o, { summary: 'x' })), /"set"/);
});

test('the remix model gets one correction, then the reply must be valid', async () => {
  const o = original();
  let n = 0;
  const pushy: Brain = (v) => (v.req.purpose === 'remix' ? { text: JSON.stringify(n++ === 0 ? { set: { name: 'Free Digest', makerFee: 0 } } : { summary: 'Shorter.', set: { name: 'Short Digest', systemPrompt: `${o.systemPrompt}\nKeep it under 60 words.` } }) } : null);
  const r = await generateRemix(new FakeProvider([pushy]), o, 'Keep it under 60 words', 'd_test');
  assert.equal(n, 2);
  assert.equal(r.spec.name, 'Short Digest');
  assert.equal(r.spec.makerFee, 10_000);
  const stubborn: Brain = (v) => (v.req.purpose === 'remix' ? { text: JSON.stringify({ set: { name: 'Free Digest', makerFee: 0 } }) } : null);
  await assert.rejects(generateRemix(new FakeProvider([stubborn]), o, 'Make it free', 'd_test'), SpecError);
  // The model never sees the price or the slug.
  let seen = '';
  const spy: Brain = (v) => (v.req.purpose === 'remix' ? ((seen = v.messages[1].content), null) : null);
  await generateRemix(new FakeProvider([spy]), o, 'Also return a follow up email subject', 'd_test');
  assert.ok(!seen.includes('makerFee') && !seen.includes('"slug"'), seen.slice(0, 200));
  assert.ok(seen.startsWith('Change request: Also return'));
});

test('edits to a remix draft keep its rules', () => {
  const o = original();
  const r = applyRemix(o, { set: { name: 'Short Digest', systemPrompt: `${o.systemPrompt}\nShort.` } }).spec;
  assert.deepEqual(remixProblems(o, r, 10_000), []);
  assert.equal(remixProblems(o, { ...r, makerFee: 9_999 }, 10_000).length, 1);
  assert.deepEqual(remixProblems(o, { ...r, makerFee: 1_000 }, 0), [], 'no floor against an example or yourself');
});

test('the royalty comes out of the maker part: the caller pays the same', () => {
  const s = original();
  const rules = { platformFeeBps: 1000, platformFeeMinMicros: 2000 };
  const plain = priceFor(s, rules);
  const remix = priceFor(s, rules, null, REMIX_ROYALTY_BPS);
  assert.equal(remix.total, plain.total);
  assert.equal(remix.ai, plain.ai);
  assert.equal(remix.platform, plain.platform);
  assert.equal(remix.royalty, 2000);
  assert.equal(remix.maker + remix.royalty, plain.maker);
  assert.equal(remix.total, remix.maker + remix.royalty + remix.ai + remix.platform);
  assert.equal(plain.royalty, 0);
  assert.equal(royaltyOf(10_001, 2000), 2000, 'rounded down to the micro-USDC');
  assert.equal(royaltyOf(1_000, 0), 0);
});

// ---------------------------------------------------------------- the split with four recipients

const usdc = Keypair.generate().publicKey.toBase58();
const maker = Keypair.generate().publicKey.toBase58();
const orig = Keypair.generate().publicKey.toBase58();
const ops = Keypair.generate().publicKey.toBase58();
const burn = Keypair.generate().publicKey.toBase58();
const memo = 'fabrica:bbbbbbbbbbbbbbbbbbbbbbbb';
const recipients = [
  { role: 'maker' as const, address: maker, amount: '8000' },
  { role: 'royalty' as const, address: orig, amount: '2000' },
  { role: 'ai' as const, address: ops, amount: '9000' },
  { role: 'platform' as const, address: burn, amount: '2000' },
];
const req = (rs = recipients): PaymentRequirements => ({
  scheme: 'split',
  network: 'solana-localnet',
  maxAmountRequired: '21000',
  resource: 'x',
  description: 'x',
  mimeType: 'application/json',
  payTo: maker,
  maxTimeoutSeconds: 600,
  asset: usdc,
  extra: { name: 'USD Coin', decimals: 6, memo, nonce: memo.slice(8), expiresAt: 0, computeUnitPrice: 1000, recipients: rs },
});
const exp = { memo, usdcMint: usdc, recipients: recipients.map((r) => ({ address: r.address, amount: Number(r.amount) })) };
const bh = '11111111111111111111111111111111';
const sign = (rq: PaymentRequirements) => {
  const payer = Keypair.generate();
  const t = buildPayment(rq, payer.publicKey, bh);
  t.sign(payer);
  return { b64: t.serialize().toString('base64'), payer, t };
};

test('the four-way split passes; dropping, shortening or redirecting the royalty does not', () => {
  assert.equal(code(() => checkRawTransaction(sign(req()).b64, exp)), 'ok');
  assert.equal(code(() => checkRawTransaction(sign(req(recipients.filter((r) => r.role !== 'royalty'))).b64, exp)), 'recipient');
  assert.equal(code(() => checkRawTransaction(sign(req(recipients.map((r) => (r.role === 'royalty' ? { ...r, amount: '1999' } : r)))).b64, exp)), 'amount');
  assert.equal(code(() => checkRawTransaction(sign(req(recipients.map((r) => (r.role === 'royalty' ? { ...r, address: maker } : r)))).b64, exp)), 'recipient');
  const folded = recipients.filter((r) => r.role !== 'royalty').map((r) => (r.role === 'maker' ? { ...r, amount: '10000' } : r));
  assert.equal(code(() => checkRawTransaction(sign(req(folded)).b64, exp)), 'amount');
});

test('with every recipient needing a new USDC account the payment still fits one transaction', () => {
  const all = recipients.map((r) => ({ ...r, createAccount: true }));
  const { b64 } = sign(req(all));
  assert.ok(Buffer.from(b64, 'base64').length <= 1232, `${Buffer.from(b64, 'base64').length} bytes`);
  assert.equal(code(() => checkRawTransaction(b64, exp)), 'ok');
});

test('the chain record is checked too: a sent payment without the royalty is refused', async () => {
  const chain = new FakeChain(usdc);
  for (const r of recipients) chain.openUsdc(r.address);
  const pay = async (rq: PaymentRequirements) => {
    const payer = Keypair.generate();
    chain.fundUsdc(payer.publicKey.toBase58(), 1_000_000);
    const t = buildPayment(rq, payer.publicKey, bh);
    t.sign(payer);
    return chain.call('getTransaction', [await chain.call('sendTransaction', [t.serialize().toString('base64')])]);
  };
  assert.equal(code(() => checkConfirmed(null, exp)), 'not_found');
  const good = await pay(req());
  assert.equal(code(() => checkConfirmed(good, exp)), 'ok');
  assert.equal(chain.usdcBalance(orig), 2000n);
  const without = await pay(req(recipients.filter((r) => r.role !== 'royalty')));
  assert.equal(code(() => checkConfirmed(without, exp)), 'recipient');
});

test('receipts: no royalty keeps the v1 message; a royalty is signed in v2 and can not be edited', () => {
  const keys = receiptKeys(openMemoryDb());
  const pub = bs58.encode(keys.publicKey);
  const base = { id: 'r_x', agentSlug: 'a', payer: 'p', txSig: 's', total: 21000, maker: 8000, royalty: 0, royaltyTo: null, ai: 9000, platform: 2000, status: 'ok' as const, inputHash: 'i', outputHash: 'o', ms: 5, aiCostMicros: 1, createdAt: 1, version: 0 };
  assert.ok(receiptMessage(base).startsWith('fabrica-receipt:v1|r_x|a|p|s|21000|8000|9000|'));
  const r = { ...base, maker: 6000, royalty: 2000, royaltyTo: orig };
  assert.ok(receiptMessage(r).startsWith(`fabrica-receipt:v2|r_x|a|p|s|21000|6000|2000|${orig}|9000|`));
  const serverSig = signReceipt(keys, r);
  assert.equal(verifyReceipt(pub, { ...r, serverSig }), true);
  assert.equal(verifyReceipt(pub, { ...r, royaltyTo: maker, serverSig }), false);
  assert.equal(verifyReceipt(pub, { ...r, royalty: 0, serverSig }), false);
});

test('before and after: a line diff that keeps unchanged lines in place', () => {
  assert.deepEqual(lineDiff(['a', 'b', 'c'], ['a', 'x', 'c', 'd']), [
    { op: 'same', text: 'a' },
    { op: 'del', text: 'b' },
    { op: 'add', text: 'x' },
    { op: 'same', text: 'c' },
    { op: 'add', text: 'd' },
  ]);
  const o = original();
  assert.deepEqual(specChanges(o, o), []);
  const fee = specChanges(o, { ...o, makerFee: 20_000 });
  assert.deepEqual(fee.map((c) => [c.field, c.behaviour]), [['makerFee', false]]);
});

test('the copy check: verbatim instructions match, different agents built from one template do not', () => {
  const a = normalizeSpec(standInSpec('Summarise any pasted text into three plain bullet points for busy readers')).systemPrompt;
  const b = normalizeSpec(standInSpec('Extract every invoice number and total from a pasted invoice')).systemPrompt;
  assert.equal(overlap(a, a), 1);
  for (const [x, y] of [[a, b], [b, a], [normalizeSpec(standInSpec('Summarise text')).systemPrompt, a]]) assert.ok(overlap(x, y) < COPY_THRESHOLD, `two agents from one template: ${overlap(x, y)}`);
  assert.equal(overlap(a, `My own opening line.\n${a}\nOne more line of my own.`), 1, 'a pasted copy with lines added');
  const long = releaseNotes.spec.systemPrompt as string;
  assert.ok(overlap(long, long.replace('clean sentence', 'tidy sentence')) >= COPY_THRESHOLD, 'a real-length copy with a word changed');
  assert.equal(overlap('Too short to judge.', 'Too short to judge.'), 0);
});

test('a database from before remixes gets the new columns when it opens', () => {
  const dir = tmpDir('fab-mig');
  const old = new DatabaseSync(path.join(dir, 'fabrica.db'));
  old.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, maker TEXT, status TEXT NOT NULL, example INTEGER NOT NULL DEFAULT 0, spec TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, test_run_id TEXT, draft_id TEXT, published_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pause_reason TEXT, coin_mint TEXT, coin_symbol TEXT, coin_name TEXT, coin_launch_sig TEXT, coin_launched_at INTEGER, coin_curve TEXT, buyback_bps INTEGER NOT NULL DEFAULT 0, has_image INTEGER NOT NULL DEFAULT 0, sentence TEXT);
    INSERT INTO agents (id, slug, maker, status, spec, published_at, updated_at) VALUES ('a_1', 'one', 'm', 'live', '{}', 1, 1);
    CREATE TABLE receipts (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, quote_nonce TEXT UNIQUE NOT NULL, tx_sig TEXT UNIQUE NOT NULL, payer TEXT NOT NULL, total INTEGER NOT NULL, maker_amt INTEGER NOT NULL, ai_amt INTEGER NOT NULL, platform_amt INTEGER NOT NULL, status TEXT NOT NULL, input_hash TEXT NOT NULL, output_hash TEXT, output TEXT, error TEXT, retry_token TEXT, retry_used INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, ai_cost INTEGER NOT NULL DEFAULT 0, slot INTEGER, server_sig TEXT NOT NULL DEFAULT '', buyback_bps INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);`);
  old.close();
  const db = openDb(dir);
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  for (const c of ['parent_id', 'royalty_bps', 'fee_floor']) assert.ok(cols('agents').includes(c), c);
  for (const c of ['royalty_amt', 'royalty_to']) assert.ok(cols('receipts').includes(c), c);
  assert.ok(cols('drafts').includes('remix') && cols('quotes').includes('royalty_amt'));
  assert.deepEqual({ ...(db.prepare('SELECT parent_id, royalty_bps FROM agents').get() as object) }, { parent_id: null, royalty_bps: 0 });
  db.close();
  openDb(dir).close(); // opening twice changes nothing
  fs.rmSync(dir, { recursive: true, force: true });
});
