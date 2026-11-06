// Runs the payment checks against a real Solana validator on this machine (solana-test-validator, no network,
// no real money): a real SPL token stands in for USDC, the real token, memo and associated-account programs run.
// It proves the byte check, the broadcast, the confirmed-transaction check and the balances against the real
// shapes a node returns. Usage: npm run test:validator
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { loadConfig } from '../server/config';
import { openMemoryDb } from '../server/db';
import { Payments } from '../server/pay/payments';
import { HttpRpc } from '../server/solana/rpc';
import { buildPayment, createAtaIdempotentIx, paymentHeader, TOKEN_PROGRAM_ID, usdcAccount } from '../shared/pay';

const BIN = path.join(os.homedir(), '.local/share/solana/install/solana-release/bin/solana-test-validator');
const PORT = 18899;
const ledger = fs.mkdtempSync(path.join(os.tmpdir(), 'fabrica-ledger-'));
const v = spawn('nice', [BIN, '--reset', '--quiet', '--ledger', ledger, '--rpc-port', String(PORT), '--faucet-port', '19900', '--gossip-port', '18001', '--dynamic-port-range', '18010-18040'], { stdio: 'ignore', env: { ...process.env, COPYFILE_DISABLE: '1' } });
const url = `http://127.0.0.1:${PORT}`;
const conn = new Connection(url, 'confirmed');
const stop = () => {
  v.kill('SIGTERM');
  setTimeout(() => fs.rmSync(ledger, { recursive: true, force: true }), 1500);
};
process.on('exit', stop);

let healthy = false;
for (let i = 0; i < 90 && !healthy; i++) {
  try {
    healthy = (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' })).json()).result === 'ok';
  } catch {
    /* starting */
  }
  if (!healthy) await new Promise((r) => setTimeout(r, 1000));
}
if (!healthy) throw new Error('the validator did not start');

const fund = async (kp: Keypair) => {
  const sig = await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, 'confirmed');
};
const authority = Keypair.generate();
const payer = Keypair.generate();
await fund(authority);
await fund(payer);

// A 6-decimal SPL token in the role of USDC.
const mint = Keypair.generate();
const init = Buffer.alloc(67);
init.writeUInt8(20, 0);
init.writeUInt8(6, 1);
authority.publicKey.toBuffer().copy(init, 2);
init.writeUInt8(0, 34);
await sendAndConfirmTransaction(
  conn,
  new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: mint.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(82), space: 82, programId: TOKEN_PROGRAM_ID }),
    new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }], data: init.subarray(0, 67) }),
  ),
  [authority, mint],
);
const mintTo = Buffer.alloc(9);
mintTo.writeUInt8(7, 0);
mintTo.writeBigUInt64LE(10_000_000n, 1);
await sendAndConfirmTransaction(
  conn,
  new Transaction().add(
    createAtaIdempotentIx(authority.publicKey, payer.publicKey, mint.publicKey),
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: usdcAccount(payer.publicKey, mint.publicKey), isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      ],
      data: mintTo,
    }),
  ),
  [authority],
);

const maker = Keypair.generate().publicKey.toBase58();
const ops = Keypair.generate().publicKey.toBase58();
const burn = Keypair.generate().publicKey.toBase58();
const cfg = loadConfig({ FABRICA_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'fab-v-')), FABRICA_NETWORK: 'solana-localnet', FABRICA_USDC_MINT: mint.publicKey.toBase58(), FABRICA_OPS_WALLET: ops, FABRICA_BURN_WALLET: burn });
const db = openMemoryDb();
const pay = new Payments(db, cfg, new HttpRpc([url]));
const results: Record<string, unknown> = {};
const bal = async (owner: string) => BigInt((await conn.getTokenAccountBalance(usdcAccount(new PublicKey(owner), mint.publicKey)).catch(() => ({ value: { amount: '0' } }))).value.amount);

// 1. Fresh recipients have no USDC account: the quote asks the payer to create them, and the check allows exactly that.
const q1 = await pay.makeQuote({ kind: 'call', agentId: 'a1', inputHash: 'h', price: { total: 30_000, maker: 20_000, royalty: 0, ai: 8_000, platform: 2_000 }, makerWallet: maker, ip: 'x', resource: 'r', description: 'd' });
results.createAccountsRequested = q1.extra.recipients.every((r) => r.createAccount);
const t1 = buildPayment(q1, payer.publicKey, (await conn.getLatestBlockhash()).blockhash);
t1.sign(payer);
const s1 = await pay.settle(paymentHeader(q1, { transaction: t1.serialize().toString('base64') }), () => {});
results.transactionMode = { sig: s1.sig.slice(0, 12), maker: String(await bal(maker)), ops: String(await bal(ops)), burn: String(await bal(burn)) };

// 2. Signature mode: the payer sends it, Fabrica only reads it.
const q2 = await pay.makeQuote({ kind: 'call', agentId: 'a1', inputHash: 'h', price: { total: 30_000, maker: 20_000, royalty: 0, ai: 8_000, platform: 2_000 }, makerWallet: maker, ip: 'x', resource: 'r', description: 'd' });
const t2 = buildPayment(q2, payer.publicKey, (await conn.getLatestBlockhash()).blockhash);
const sig2 = await conn.sendTransaction(t2, [payer]);
const s2 = await pay.settle(paymentHeader(q2, { signature: sig2 }), () => {});
results.signatureMode = s2.slot > 0;

// 3. Replays and tampering are refused.
const replay = await pay.settle(paymentHeader(q2, { signature: sig2 }), () => {}).then(() => 'accepted', (e) => e.code);
results.replay = replay;
const q3 = await pay.makeQuote({ kind: 'call', agentId: 'a1', inputHash: 'h', price: { total: 30_000, maker: 20_000, royalty: 0, ai: 8_000, platform: 2_000 }, makerWallet: maker, ip: 'x', resource: 'r', description: 'd' });
const t3 = buildPayment({ ...q3, extra: { ...q3.extra, recipients: q3.extra.recipients.map((r) => (r.role === 'maker' ? { ...r, amount: '1' } : r)) } }, payer.publicKey, (await conn.getLatestBlockhash()).blockhash);
const sig3 = await conn.sendTransaction(t3, [payer]);
results.underpaid = await pay.settle(paymentHeader(q3, { signature: sig3 }), () => {}).then(() => 'accepted', (e) => e.code);

// 4. A remix: four recipients in one transaction, the royalty to the original maker, whose account is created on the way.
const remixMaker = Keypair.generate().publicKey.toBase58();
const original = Keypair.generate().publicKey.toBase58();
const remixPrice = { total: 30_000, maker: 16_000, royalty: 4_000, ai: 8_000, platform: 2_000 };
const q4 = await pay.makeQuote({ kind: 'call', agentId: 'a2', inputHash: 'h', price: remixPrice, makerWallet: remixMaker, royaltyWallet: original, ip: 'x', resource: 'r', description: 'd' });
const t4 = buildPayment(q4, payer.publicKey, (await conn.getLatestBlockhash()).blockhash);
t4.sign(payer);
results.remixTransactionBytes = t4.serialize().length;
await pay.settle(paymentHeader(q4, { transaction: t4.serialize().toString('base64') }), () => {});
results.remixSplit = { maker: String(await bal(remixMaker)), royalty: String(await bal(original)), recipients: q4.extra.recipients.map((r) => r.role).join(',') };

// 5. Sent without the royalty: the chain moved the rest, but the confirmed transaction is refused and the quote stays open.
const q5 = await pay.makeQuote({ kind: 'call', agentId: 'a2', inputHash: 'h', price: remixPrice, makerWallet: remixMaker, royaltyWallet: original, ip: 'x', resource: 'r', description: 'd' });
const t5 = buildPayment({ ...q5, extra: { ...q5.extra, recipients: q5.extra.recipients.filter((r) => r.role !== 'royalty') } }, payer.publicKey, (await conn.getLatestBlockhash()).blockhash);
const sig5 = await conn.sendTransaction(t5, [payer]);
results.royaltyLeftOut = await pay.settle(paymentHeader(q5, { signature: sig5 }), () => {}).then(() => 'accepted', (e) => e.code);
results.quoteStillOpen = pay.quote(q5.extra.nonce)?.claimed_sig === null;

const expect = {
  createAccountsRequested: true,
  transactionMode: { maker: '20000', ops: '8000', burn: '2000' },
  signatureMode: true,
  replay: 'used',
  underpaid: 'amount',
  remixSplit: { maker: '16000', royalty: '4000', recipients: 'maker,royalty,ai,platform' },
  royaltyLeftOut: 'recipient',
  quoteStillOpen: true,
};
const rs = results.remixSplit as any;
const ok =
  results.createAccountsRequested === true &&
  (results.transactionMode as any).maker === '20000' &&
  (results.transactionMode as any).ops === '8000' &&
  (results.transactionMode as any).burn === '2000' &&
  results.signatureMode === true &&
  results.replay === 'used' &&
  results.underpaid === 'amount' &&
  rs.maker === '16000' &&
  rs.royalty === '4000' &&
  rs.recipients === 'maker,royalty,ai,platform' &&
  results.royaltyLeftOut === 'recipient' &&
  results.quoteStillOpen === true;
console.log(JSON.stringify({ results, expect, ok }, null, 2));
stop();
setTimeout(() => process.exit(ok ? 0 : 1), 500);
