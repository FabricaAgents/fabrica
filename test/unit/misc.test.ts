import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { openMemoryDb } from '../../server/db';
import { RateLimiter, SpendLedger, Gates } from '../../server/safety/limits';
import { receiptKeys, signReceipt, verifyReceipt } from '../../server/pay/receipts';
import { isSimulatedSignature } from '../../server/solana/rpc';
import { ChainStream } from '../../server/solana/stream';
import { usd, compact, shortAddr } from '../../shared/format';
import bs58 from 'bs58';

test('rate limits hold per key and reset', () => {
  let now = 0;
  const rl = new RateLimiter(() => now);
  for (let i = 0; i < 5; i++) assert.equal(rl.take('a', 5, 1000), true);
  assert.equal(rl.take('a', 5, 1000), false);
  assert.equal(rl.take('b', 5, 1000), true);
  now = 1001;
  assert.equal(rl.take('a', 5, 1000), true);
});

test('daily AI caps hold per agent and overall', () => {
  const l = new SpendLedger(openMemoryDb(), 1000, 600);
  assert.equal(l.room('x', 500).ok, true);
  l.add('x', 500);
  assert.equal(l.room('x', 200).ok, false);
  assert.equal(l.room('y', 450).ok, true);
  l.add('y', 450);
  assert.match(l.room('z', 100).reason!, /Fabrica/);
});

test('concurrency gates', () => {
  const g = new Gates();
  for (let i = 0; i < 4; i++) assert.equal(g.tryEnter('a'), true);
  assert.equal(g.tryEnter('a'), false);
  g.leave('a');
  assert.equal(g.tryEnter('a'), true);
});

test('receipts are signed and any edit breaks the signature', () => {
  const keys = receiptKeys(openMemoryDb());
  const r = { id: 'r_x', agentSlug: 'a', payer: 'p', txSig: 's', total: 3, maker: 1, royalty: 0, royaltyTo: null, ai: 1, platform: 1, status: 'ok' as const, inputHash: 'i', outputHash: 'o', ms: 5, aiCostMicros: 1, createdAt: 1 };
  const serverSig = signReceipt(keys, r);
  const pub = bs58.encode(keys.publicKey);
  assert.equal(verifyReceipt(pub, { ...r, serverSig }), true);
  assert.equal(verifyReceipt(pub, { ...r, total: 4, serverSig }), false);
});

test('simulated transactions in logsSubscribe are dropped', () => {
  assert.equal(isSimulatedSignature('1'.repeat(88)), true);
  assert.equal(isSimulatedSignature(bs58.encode(Keypair.generate().secretKey)), false);
  const refreshed: string[] = [];
  const fake: any = { db: { prepare: () => ({ all: () => [] }) }, cfg: { wsUrl: null }, coins: { refreshCurve: async (m: string) => refreshed.push(m) } };
  const s = new ChainStream(fake);
  (s as any).subs.set(7, 'MINT');
  s.onMessage(JSON.stringify({ method: 'logsNotification', params: { subscription: 7, result: { value: { signature: '1'.repeat(88), err: null, logs: [] } } } }));
  assert.equal(s.stats.simulatedDropped, 1);
  assert.equal(s.stats.events, 0);
  s.onMessage(JSON.stringify({ method: 'logsNotification', params: { subscription: 7, result: { value: { signature: '5'.repeat(88), err: null, logs: [] } } } }));
  assert.equal(s.stats.events, 1);
  s.stop();
});

test('formatting', () => {
  assert.equal(usd(17_000), '$0.017');
  assert.equal(usd(2_000), '$0.002');
  assert.equal(usd(1_500_000), '$1.50');
  assert.equal(compact(12_345), '12k');
  assert.equal(shortAddr('ABCDEFGHIJKL'), 'ABCD…IJKL');
});
