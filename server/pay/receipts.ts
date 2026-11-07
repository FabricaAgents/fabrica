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
 * What the server signs. Receipts that record the agent's version (every receipt since versions) sign v3, which
 * adds the version and always carries the royalty fields. Older receipts keep the message they were signed with:
 * v1 without a royalty, v2 with one, so every receipt ever issued still verifies.
 */
export function receiptMessage(r: Omit<Receipt, 'serverSig'>): string {
  // Receipt trees: a call that hired or could hire, and every hired call, sign v4 with their place in the tree.
  if ((r.depth ?? 0) > 0) return ['fabrica-receipt:v4', r.id, r.agentSlug, r.version, r.parentId ?? '', r.rootId ?? '', r.depth, r.payer, r.txSig, r.total, r.maker, r.royalty, r.royaltyTo ?? '', r.ai, r.platform, r.hires ?? 0, r.planHash ?? '', r.inputHash, r.outputHash ?? '', r.status, r.createdAt].join('|');
  if (r.version > 0) return ['fabrica-receipt:v3', r.id, r.agentSlug, r.version, r.payer, r.txSig, r.total, r.maker, r.royalty, r.royaltyTo ?? '', r.ai, r.platform, r.inputHash, r.outputHash ?? '', r.status, r.createdAt].join('|');
  if (r.royalty > 0) return ['fabrica-receipt:v2', r.id, r.agentSlug, r.payer, r.txSig, r.total, r.maker, r.royalty, r.royaltyTo ?? '', r.ai, r.platform, r.inputHash, r.outputHash ?? '', r.status, r.createdAt].join('|');
  return ['fabrica-receipt:v1', r.id, r.agentSlug, r.payer, r.txSig, r.total, r.maker, r.ai, r.platform, r.inputHash, r.outputHash ?? '', r.status, r.createdAt].join('|');
}

export const RECEIPT_FORMATS = {
  v1: 'fabrica-receipt:v1|id|agent|payer|txSig|total|maker|ai|platform|inputHash|outputHash|status|createdAt',
  v2: 'fabrica-receipt:v2|id|agent|payer|txSig|total|maker|royalty|royaltyTo|ai|platform|inputHash|outputHash|status|createdAt',
  v3: 'fabrica-receipt:v3|id|agent|version|payer|txSig|total|maker|royalty|royaltyTo|ai|platform|inputHash|outputHash|status|createdAt',
  v4: 'fabrica-receipt:v4|id|agent|version|parent|root|depth|payer|txSig|total|maker|royalty|royaltyTo|ai|platform|hires|planHash|inputHash|outputHash|status|createdAt',
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
/** A hired call's receipt id. Same length as a call receipt, so one route pattern reads both. */
export const newHireId = () => `h_${randomBytes(9).toString('base64url')}`;
export const hashPlan = (planJson: string) => createHash('sha256').update(planJson).digest('hex');
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
  version: number;
  hires_amt: number;
  plan: string | null;
  depth: number;
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
    version: row.version ?? 0,
    ...(row.depth > 0 ? { depth: row.depth, parentId: null, rootId: row.id, hires: row.hires_amt ?? 0, planHash: row.plan ? hashPlan(row.plan) : '' } : {}),
    serverSig: row.server_sig,
  };
}

export interface HireRow {
  id: string;
  root_id: string;
  parent_id: string;
  slot: number;
  attempt: number;
  depth: number;
  agent_id: string;
  version: number;
  payer: string;
  tx_sig: string;
  total: number;
  maker_amt: number;
  royalty_amt: number;
  royalty_to: string | null;
  ai_amt: number;
  platform_amt: number;
  hires_amt: number;
  status: 'ok' | 'failed';
  input_hash: string;
  output_hash: string | null;
  output: string | null;
  error: string | null;
  ms: number;
  ai_cost: number;
  server_sig: string;
  created_at: number;
}

/** A hired call's receipt, signed v4 like the top receipt of its tree. */
export function hireToReceipt(row: HireRow, slug: string): Receipt {
  return {
    id: row.id,
    agentSlug: slug,
    payer: row.payer,
    txSig: row.tx_sig,
    total: row.total,
    maker: row.maker_amt,
    royalty: row.royalty_amt,
    royaltyTo: row.royalty_to,
    ai: row.ai_amt,
    platform: row.platform_amt,
    status: row.status,
    inputHash: row.input_hash,
    outputHash: row.output_hash,
    ms: row.ms,
    aiCostMicros: row.ai_cost,
    createdAt: row.created_at,
    version: row.version,
    depth: row.depth,
    parentId: row.parent_id,
    rootId: row.root_id,
    hires: row.hires_amt,
    planHash: '',
    serverSig: row.server_sig,
  };
}
