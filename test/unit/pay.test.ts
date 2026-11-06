import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { buildPayment, transferCheckedIx, usdcAccount } from '../../shared/pay';
import { checkConfirmed, checkRawTransaction, PaymentError } from '../../server/pay/verify';
import { FakeChain } from '../../server/solana/fake-chain';
import { priceFor } from '../../server/pay/price';
import { normalizeSpec } from '../../server/spec/schema';
import { standInSpec } from '../../server/ai/fake';
import type { PaymentRequirements } from '../../shared/types';

const usdc = Keypair.generate().publicKey.toBase58();
const maker = Keypair.generate().publicKey.toBase58();
const ops = Keypair.generate().publicKey.toBase58();
const req = (memo = 'fabrica:aaaaaaaaaaaaaaaaaaaaaaaa'): PaymentRequirements => ({
  scheme: 'split',
  network: 'solana-localnet',
  maxAmountRequired: '30000',
  resource: 'x',
  description: 'x',
  mimeType: 'application/json',
  payTo: maker,
  maxTimeoutSeconds: 600,
  asset: usdc,
  extra: { name: 'USD Coin', decimals: 6, memo, nonce: memo.slice(8), expiresAt: 0, computeUnitPrice: 1000, recipients: [{ role: 'maker', address: maker, amount: '20000' }, { role: 'ai', address: ops, amount: '10000' }] },
});
const exp = { memo: 'fabrica:aaaaaaaaaaaaaaaaaaaaaaaa', usdcMint: usdc, recipients: [{ address: maker, amount: 20000 }, { address: ops, amount: 10000 }] };
const bh = '11111111111111111111111111111111';

function signed(tamper?: (t: any, payer: Keypair) => void) {
  const payer = Keypair.generate();
  const t = buildPayment(req(), payer.publicKey, bh);
  tamper?.(t, payer);
  t.sign(payer);
  return { b64: t.serialize().toString('base64'), payer };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof PaymentError, String(e));
    return e.code;
  }
  return 'ok';
};

test('the exact payment passes the byte check', () => {
  const { b64, payer } = signed();
  assert.equal(checkRawTransaction(b64, exp).payer, payer.publicKey.toBase58());
});

test('anything else is refused', () => {
  assert.equal(code(() => checkRawTransaction(signed((t) => (t.instructions[2].data.writeBigUInt64LE(19999n, 1))).b64, exp)), 'amount');
  const raw = Buffer.from(signed().b64, 'base64');
  raw[raw.length - 3] ^= 1;
  assert.equal(code(() => checkRawTransaction(raw.toString('base64'), exp)), 'bad_signature');
  assert.equal(code(() => checkRawTransaction(signed((t, p) => t.add(SystemProgram.transfer({ fromPubkey: p.publicKey, toPubkey: p.publicKey, lamports: 1 }))).b64, exp)), 'instructions');
  assert.equal(code(() => checkRawTransaction(signed((t, p) => (t.instructions[2] = transferCheckedIx(usdcAccount(p.publicKey, new PublicKey(usdc)), new PublicKey(usdc), usdcAccount(p.publicKey, new PublicKey(usdc)), p.publicKey, 20000n, 6))).b64, exp)), 'recipient');
  assert.equal(code(() => checkRawTransaction(signed((t, p) => (t.instructions[2] = transferCheckedIx(usdcAccount(p.publicKey, new PublicKey(usdc)), new PublicKey(usdc), usdcAccount(new PublicKey(maker), new PublicKey(usdc)), p.publicKey, 1n, 6))).b64, exp)), 'amount');
  assert.equal(code(() => checkRawTransaction(signed((t) => t.instructions.pop()).b64, exp)), 'memo');
  assert.equal(code(() => checkRawTransaction(signed((t) => t.instructions.splice(3, 1)).b64, exp)), 'recipient');
});

test('the confirmed transaction is checked as the chain recorded it, balances included', async () => {
  const chain = new FakeChain(usdc);
  const payer = Keypair.generate();
  chain.fundUsdc(payer.publicKey.toBase58(), 1_000_000);
  chain.openUsdc(maker);
  chain.openUsdc(ops);
  const t = buildPayment(req(), payer.publicKey, bh);
  t.sign(payer);
  const sig = await chain.call('sendTransaction', [t.serialize().toString('base64')]);
  const parsed = await chain.call('getTransaction', [sig]);
  assert.equal(checkConfirmed(parsed, exp).payer, payer.publicKey.toBase58());
  assert.equal(chain.usdcBalance(maker), 20000n);
  const wrong = { ...exp, recipients: [{ address: maker, amount: 20001 }, exp.recipients[1]] };
  assert.equal(code(() => checkConfirmed(parsed, wrong)), 'amount');
  assert.equal(code(() => checkConfirmed({ ...parsed, meta: { ...parsed.meta, err: { x: 1 } } }, exp)), 'failed_on_chain');
});

test('a wallet that cannot pay gets nothing through', async () => {
  const chain = new FakeChain(usdc);
  const payer = Keypair.generate();
  chain.fundUsdc(payer.publicKey.toBase58(), 100);
  chain.openUsdc(maker);
  chain.openUsdc(ops);
  const t = buildPayment(req(), payer.publicKey, bh);
  t.sign(payer);
  await assert.rejects(chain.call('sendTransaction', [t.serialize().toString('base64')]));
  assert.equal(chain.usdcBalance(maker), 0n);
});

test('the price always covers the AI ceiling and a platform fee', () => {
  const spec = normalizeSpec(standInSpec('Summarise any public web page into bullet points'));
  const p = priceFor(spec, { platformFeeBps: 1000, platformFeeMinMicros: 2000 });
  assert.equal(p.total, p.maker + p.ai + p.platform);
  assert.ok(p.ai > 0 && p.platform >= 2000);
  const disc = priceFor(spec, { platformFeeBps: 1000, platformFeeMinMicros: 0 }, { name: 't', minTokens: 1, liveAgents: 3, buildDiscountBps: 0, feeDiscountBps: 5000, earlyAccess: false });
  assert.ok(disc.platform < priceFor(spec, { platformFeeBps: 1000, platformFeeMinMicros: 0 }).platform);
});
