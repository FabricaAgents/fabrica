// Checks that a payment is exactly what a quote asked for: the right amounts, from the payer's own USDC account,
// straight into each recipient's USDC account, with the quote's memo, and nothing else in the transaction.
// A transaction is checked twice: as bytes before it is broadcast, and as the chain recorded it after.
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import nacl from 'tweetnacl';
import { ATA_PROGRAM_ID, COMPUTE_BUDGET_ID, MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID, usdcAccount } from '../../shared/pay';

export class PaymentError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 402,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

export interface Expected {
  memo: string;
  usdcMint: string;
  recipients: { address: string; amount: number }[];
}

export interface DecodedPayment {
  payer: string;
  memo: string;
}

export function decodeHeader(raw: string | undefined): { scheme: string; network: string; payload: { transaction?: string; signature?: string } } {
  if (!raw) throw new PaymentError('missing', 'No payment was attached.');
  let j: any;
  try {
    j = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new PaymentError('malformed', 'The payment header is not base64 JSON.', 400);
  }
  if (!j || typeof j !== 'object' || !j.payload || typeof j.payload !== 'object') throw new PaymentError('malformed', 'The payment header has no payload.', 400);
  return { scheme: String(j.scheme ?? ''), network: String(j.network ?? ''), payload: j.payload };
}

function fail(code: string, msg: string): never {
  throw new PaymentError(code, msg);
}

/** Checks a signed transaction before it is broadcast. Returns the payer and memo. */
export function checkRawTransaction(b64: string, exp: Expected): { tx: VersionedTransaction; payer: string; memo: string } {
  let tx: VersionedTransaction;
  try {
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length > 1232) fail('too_large', 'The transaction is larger than Solana allows.');
    tx = VersionedTransaction.deserialize(bytes);
  } catch (e) {
    if (e instanceof PaymentError) throw e;
    throw new PaymentError('malformed', 'The transaction could not be read.', 400);
  }
  const msg = tx.message;
  if (msg.addressTableLookups?.length) fail('lookup_tables', 'Payments may not use address lookup tables.');
  const keys = msg.staticAccountKeys;
  const payer = keys[0];
  const signers = msg.header.numRequiredSignatures;
  if (signers !== 1) fail('signers', 'The payer must be the only signer.');
  const bytes = msg.serialize();
  if (!tx.signatures[0] || !nacl.sign.detached.verify(bytes, tx.signatures[0], payer.toBytes())) fail('bad_signature', 'The payer signature does not verify.');

  const mint = new PublicKey(exp.usdcMint);
  const source = usdcAccount(payer, mint);
  const want = new Map(exp.recipients.map((r) => [usdcAccount(new PublicKey(r.address), mint).toBase58(), { ...r, seen: false }]));
  let memo: string | null = null;
  for (const ix of msg.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    const acct = (i: number) => keys[ix.accountKeyIndexes[i]];
    const data = Buffer.from(ix.data);
    if (program.equals(COMPUTE_BUDGET_ID)) {
      if (data[0] !== 2 && data[0] !== 3) fail('instructions', 'Only compute limit and price instructions are allowed.');
      if (data[0] === 3 && data.readBigUInt64LE(1) > 5_000_000n) fail('instructions', 'The priority fee is unreasonably high.');
      continue;
    }
    if (program.equals(MEMO_PROGRAM_ID)) {
      if (memo !== null) fail('memo', 'Only one memo is allowed.');
      memo = data.toString('utf8');
      continue;
    }
    if (program.equals(ATA_PROGRAM_ID)) {
      if (!(data.length === 1 && data[0] === 1)) fail('instructions', 'Only idempotent account creation is allowed.');
      if (!want.has(acct(1).toBase58()) || !acct(3).equals(mint)) fail('instructions', 'Accounts may only be created for the recipients.');
      continue;
    }
    if (program.equals(TOKEN_PROGRAM_ID)) {
      if (data[0] !== 12 || data.length !== 10) fail('instructions', 'Only checked transfers are allowed.');
      const amount = data.readBigUInt64LE(1);
      if (data[9] !== 6) fail('decimals', 'USDC has 6 decimals.');
      if (!acct(0).equals(source)) fail('source', "Payments must come from the payer's own USDC account.");
      if (!acct(1).equals(mint)) fail('mint', 'The payment must be in USDC.');
      if (!acct(3).equals(payer)) fail('authority', 'The payer must sign the transfer.');
      const r = want.get(acct(2).toBase58());
      if (!r) fail('recipient', 'The transaction pays an account that is not in the quote.');
      if (r!.seen) fail('recipient', 'A recipient is paid twice.');
      if (amount !== BigInt(r!.amount)) fail('amount', `A recipient gets ${amount}, the quote says ${r!.amount}.`);
      r!.seen = true;
      continue;
    }
    fail('instructions', `The transaction calls a program that has no place in a payment (${program.toBase58()}).`);
  }
  for (const r of want.values()) if (!r.seen) fail('recipient', `The transaction does not pay ${r.address}.`);
  if (memo !== exp.memo) fail('memo', 'The memo does not match the quote.');
  return { tx, payer: payer.toBase58(), memo: memo as string };
}

/** Reads the memo out of a confirmed, jsonParsed transaction. */
export function memoOf(parsed: any): string | null {
  for (const ix of parsed?.transaction?.message?.instructions ?? []) {
    if (ix.programId === MEMO_PROGRAM_ID.toBase58() || ix.program === 'spl-memo') return typeof ix.parsed === 'string' ? ix.parsed : null;
  }
  return null;
}

/**
 * Checks a confirmed transaction as the chain recorded it (jsonParsed). Wallets may add their own guard
 * instructions when they send, so other programs are tolerated here; what matters is that each recipient
 * received exactly one checked transfer of its amount from the payer's USDC account, the memo is the quote's,
 * and the recorded balances agree.
 */
export function checkConfirmed(parsed: any, exp: Expected): { payer: string; slot: number; blockTime: number | null } {
  if (!parsed) fail('not_found', 'The transaction was not found on chain.');
  if (parsed.meta?.err) fail('failed_on_chain', 'The transaction failed on chain, so nothing was paid.');
  const msg = parsed.transaction?.message ?? {};
  const keys: { pubkey: string; signer: boolean }[] = (msg.accountKeys ?? []).map((k: any) => (typeof k === 'string' ? { pubkey: k, signer: false } : k));
  const payer = keys[0]?.pubkey;
  if (!payer || !keys[0].signer) fail('payer', 'The transaction has no payer.');
  const mint = new PublicKey(exp.usdcMint);
  const source = usdcAccount(new PublicKey(payer), mint).toBase58();
  const want = new Map(exp.recipients.map((r) => [usdcAccount(new PublicKey(r.address), mint).toBase58(), { ...r, seen: false }]));
  let memoOk = false;
  for (const ix of msg.instructions ?? []) {
    const program = ix.programId;
    if (program === MEMO_PROGRAM_ID.toBase58()) {
      if (ix.parsed === exp.memo) memoOk = true;
      continue;
    }
    if (program !== TOKEN_PROGRAM_ID.toBase58()) continue;
    const info = ix.parsed?.info;
    const r = info ? want.get(info.destination) : undefined;
    if (!r) continue;
    if (ix.parsed?.type !== 'transferChecked') fail('instructions', 'Recipients must be paid with checked transfers.');
    if (info.source !== source || info.mint !== exp.usdcMint || info.authority !== payer) fail('source', 'The transfer is not from the payer’s own USDC account.');
    if (r.seen) fail('recipient', 'A recipient is paid twice.');
    if (String(info.tokenAmount?.amount) !== String(r.amount)) fail('amount', 'An amount does not match the quote.');
    r.seen = true;
  }
  for (const r of want.values()) if (!r.seen) fail('recipient', `The transaction does not pay ${r.address}.`);
  if (!memoOk) fail('memo', 'The memo does not match the quote.');
  // The balances the chain recorded are the last word: every recipient account grew by at least its amount.
  const keysList = keys.map((k) => k.pubkey);
  const bal = (list: any[], acct: string) => {
    const i = keysList.indexOf(acct);
    const b = (list ?? []).find((x: any) => x.accountIndex === i && x.mint === exp.usdcMint);
    return BigInt(b?.uiTokenAmount?.amount ?? '0');
  };
  for (const [acct, r] of want) {
    // Paying yourself (a maker calling their own agent) moves nothing in that account; the transfer was checked above.
    if (acct === source) continue;
    const delta = bal(parsed.meta?.postTokenBalances, acct) - bal(parsed.meta?.preTokenBalances, acct);
    if (delta < BigInt(r.amount)) fail('balance', 'The recorded balances do not show the payment arriving.');
  }
  return { payer, slot: Number(parsed.slot ?? 0), blockTime: parsed.blockTime ?? null };
}
