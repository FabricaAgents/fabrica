// The pump.fun instructions Fabrica builds match the program's published interface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import pumpIdl from '../../shared/pump/idl/pump.json' with { type: 'json' };
import { burnCheckedInstruction, buyExactQuoteInV3Instruction, createV2Instruction } from '../../shared/pump/instructions';
import { MINT_AUTHORITY, bondingCurvePda } from '../../shared/pump/pda';
import { decodeCurve } from '../../shared/pump/decode';
import { curveProgressBps } from '../../shared/pump/math';
import { CURVE_DEFAULTS } from '../../shared/pump/constants';

const ix = (name: string) => (pumpIdl as any).instructions.find((i: any) => i.name === name);
const user = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;

function matches(idlIx: any, built: { keys: { isSigner: boolean; isWritable: boolean; pubkey: any }[]; data: Buffer }) {
  assert.deepEqual([...built.data.subarray(0, 8)], idlIx.discriminator);
  assert.equal(built.keys.length, idlIx.accounts.length);
  idlIx.accounts.forEach((a: any, i: number) => {
    assert.equal(built.keys[i].isWritable, Boolean(a.writable), `${a.name} writable`);
    if (a.signer) assert.equal(built.keys[i].isSigner, true, `${a.name} signer`);
    if (a.address) assert.equal(built.keys[i].pubkey.toBase58(), a.address, a.name);
  });
}

test('create_v2 matches the IDL, with the maker as creator', () => {
  const built = createV2Instruction({ mint, user, name: 'Mint Inspector', symbol: 'MINT', uri: 'https://fabrica.fun/coin-meta/x.json' });
  matches(ix('create_v2'), built);
  assert.ok(built.keys[0].pubkey.equals(mint));
  assert.ok(built.keys[5].pubkey.equals(user));
  assert.ok(built.keys[1].pubkey.equals(MINT_AUTHORITY));
  assert.ok(built.keys[2].pubkey.equals(bondingCurvePda(mint)));
  assert.throws(() => createV2Instruction({ mint, user, name: 'x'.repeat(33), symbol: 'A', uri: 'u' }));
});

test('buy_exact_quote_in_v3 matches the IDL', () => {
  matches(ix('buy_exact_quote_in_v3'), buyExactQuoteInV3Instruction(user, mint, 1_000_000n, 1n));
});

test('burnChecked is SPL instruction 15', () => {
  const b = burnCheckedInstruction(user, mint, 5n, 6);
  assert.equal(b.data[0], 15);
  assert.equal(b.data.readBigUInt64LE(1), 5n);
});

test('a fresh curve decodes at zero progress', () => {
  const d = Buffer.alloc(150);
  Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(d, 0);
  d.writeBigUInt64LE(CURVE_DEFAULTS.virtualTokenReserves, 8);
  d.writeBigUInt64LE(CURVE_DEFAULTS.virtualQuoteReserves, 16);
  d.writeBigUInt64LE(CURVE_DEFAULTS.realTokenReserves, 24);
  d.writeBigUInt64LE(0n, 32);
  d.writeBigUInt64LE(CURVE_DEFAULTS.tokenTotalSupply, 40);
  user.toBuffer().copy(d, 49);
  const c = decodeCurve(d);
  assert.equal(curveProgressBps(c.realTokenReserves, c.complete), 0);
  assert.ok(c.creator.equals(user));
});
