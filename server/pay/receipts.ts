// Every paid call gets a receipt: what was paid to whom (the transaction proves it), hashes of the input and
// the output, and the outcome, signed with the server's own key so a receipt cannot be edited afterwards.
import { createHash, randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { Receipt } from '../../shared/types';
import { kvGet, kvSet, type DB } from '../db';

export function receiptKeys(db: DB): nacl.SignKeyPair {
  let seed = kvGet(db, 'receipt_seed');
  if (!seed) {
    seed = randomBytes(32).toString('hex');
    kvSet(db, 'receipt_seed', seed);
  }
  return nacl.sign.keyPair.fromSeed(Buffer.from(seed, 'hex'));
}

/**
 * What the server signs. A receipt without a royalty keeps the v1 message, so every receipt signed before remixes
 * existed still verifies; a call that paid a royalty signs v2, which adds the royalty and who received it.
 */
export function receiptMessage(r: Omit<Receipt, 'serverSig'>): string {
  if (r.royalty > 0) return ['fabrica-receipt:v2', r.id, r.agentSlug, r.payer, r.txSig, r.total, r.maker, r.royalty, r.royaltyTo ?? '', r.ai, r.platform, r.inputHash, r.outputHash ?? '', r.status, r.createdAt].join('|');
  return ['fabrica-receipt:v1', r.id, r.agentSlug, r.payer, r.txSig, r.total, r.maker, r.ai, r.platform, r.inputHash, r.outputHash ?? '', r.status, r.createdAt].join('|');
}

export const RECEIPT_FORMATS = {
  v1: 'fabrica-receipt:v1|id|agent|payer|txSig|total|maker|ai|platform|inputHash|outputHash|status|createdAt',
  v2: 'fabrica-receipt:v2|id|agent|payer|txSig|total|maker|royalty|royaltyTo|ai|platform|inputHash|outputHash|status|createdAt',
};

export function signReceipt(keys: nacl.SignKeyPair, r: Omit<Receipt, 'serverSig'>): string {
  return bs58.encode(nacl.sign.detached(new TextEncoder().encode(receiptMessage(r)), keys.secretKey));
}

export function verifyReceipt(publicKey: string, r: Receipt): boolean {
  try {
    return nacl.sign.detached.verify(new TextEncoder().encode(receiptMessage(r)), bs58.decode(r.serverSig), bs58.decode(publicKey));
  } catch {
    return false;
  }
}

export const hashOutput = (v: unknown) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');
export const newReceiptId = () => `r_${randomBytes(9).toString('base64url')}`;
export const newRetryToken = () => randomBytes(18).toString('base64url');

export interface ReceiptRow {
  id: string;
  agent_id: string;
  quote_nonce: string;
  tx_sig: string;
  payer: string;
  total: number;
  maker_amt: number;
  ai_amt: number;
  platform_amt: number;
  royalty_amt: number;
  royalty_to: string | null;
  status: Receipt['status'];
  input_hash: string;
  output_hash: string | null;
  output: string | null;
  error: string | null;
  retry_token: string | null;
  retry_used: number;
  ms: number;
  ai_cost: number;
  slot: number | null;
  server_sig: string;
  created_at: number;
}

export function toReceipt(row: ReceiptRow, slug: string): Receipt {
  return {
    id: row.id,
    agentSlug: slug,
    payer: row.payer,
    txSig: row.tx_sig,
    total: row.total,
    maker: row.maker_amt,
    royalty: row.royalty_amt ?? 0,
    royaltyTo: row.royalty_to ?? null,
    ai: row.ai_amt,
    platform: row.platform_amt,
    status: row.status,
    inputHash: row.input_hash,
    outputHash: row.output_hash,
    ms: row.ms,
    aiCostMicros: row.ai_cost,
    createdAt: row.created_at,
    serverSig: row.server_sig,
  };
}
