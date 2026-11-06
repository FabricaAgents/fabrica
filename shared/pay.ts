// The payment transaction, built the same way in the browser, in the docs' client snippet and in the tests.
// One transaction pays every recipient directly from the payer's own USDC account: there is no account in
// between that anyone could hold. The memo carries the quote's nonce so the server can match it.
import { ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import type { PaymentRequirements } from './types';

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
export const COMPUTE_BUDGET_ID = new PublicKey('ComputeBudget111111111111111111111111111111');
/** Compute for a payment: a base, each checked transfer, and each account the payer must create first. */
export function payComputeUnits(req: PaymentRequirements): number {
  const created = req.extra.recipients.filter((r) => r.createAccount).length;
  return 40_000 + req.extra.recipients.length * 12_000 + created * 40_000;
}

export function usdcAccount(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID)[0];
}

export function transferCheckedIx(source: PublicKey, mint: PublicKey, dest: PublicKey, owner: PublicKey, amount: bigint, decimals: number): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: usdcAccount(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export function memoIx(text: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: Buffer.from(text, 'utf8') });
}

/** The unsigned payment for a set of requirements. The payer signs it and pays its own network fee. */
export function buildPayment(req: PaymentRequirements, payer: PublicKey, recentBlockhash: string): Transaction {
  const mint = new PublicKey(req.asset);
  const source = usdcAccount(payer, mint);
  const t = new Transaction({ feePayer: payer, recentBlockhash });
  t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: payComputeUnits(req) }));
  if (req.extra.computeUnitPrice > 0) t.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: req.extra.computeUnitPrice }));
  for (const r of req.extra.recipients) {
    const owner = new PublicKey(r.address);
    if (r.createAccount) t.add(createAtaIdempotentIx(payer, owner, mint));
    t.add(transferCheckedIx(source, mint, usdcAccount(owner, mint), payer, BigInt(r.amount), req.extra.decimals));
  }
  t.add(memoIx(req.extra.memo, payer));
  return t;
}

/** The X-PAYMENT header value: base64 of the x402 payment payload. */
export function paymentHeader(req: PaymentRequirements, payload: { transaction: string } | { signature: string }): string {
  return Buffer.from(JSON.stringify({ x402Version: 1, scheme: req.scheme, network: req.network, payload }), 'utf8').toString('base64');
}
