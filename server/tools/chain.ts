// The solana_read tool: a short list of read-only RPC methods with checked arguments and trimmed answers.
// There is no signing and no sending here, by construction: the tool has no key and no write method.
import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { bondingCurvePda } from '../../shared/pump/pda';
import { decodeCurve } from '../../shared/pump/decode';
import { curveMarketCapLamports, curveProgressBps } from '../../shared/pump/math';
import { ADDR_RE, SIG_RE, type Rpc } from '../solana/rpc';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export class ChainArgError extends Error {}

function addr(v: unknown, name: string): string {
  const s = String(v ?? '').trim();
  if (!ADDR_RE.test(s)) throw new ChainArgError(`${name} is not a Solana address`);
  try {
    return new PublicKey(s).toBase58();
  } catch {
    throw new ChainArgError(`${name} is not a Solana address`);
  }
}

function trimTx(tx: any) {
  if (!tx) return null;
  const msg = tx.transaction?.message ?? {};
  const keys = (msg.accountKeys ?? []).map((k: any) => (typeof k === 'string' ? k : k.pubkey));
  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];
  return {
    slot: tx.slot,
    blockTime: tx.blockTime,
    fee: tx.meta?.fee,
    error: tx.meta?.err ?? null,
    signers: (msg.accountKeys ?? []).filter((k: any) => k.signer).map((k: any) => k.pubkey),
    solChanges: keys.map((k: string, i: number) => ({ account: k, lamports: (post[i] ?? 0) - (pre[i] ?? 0) })).filter((c: any) => c.lamports !== 0).slice(0, 12),
    tokenChanges: (tx.meta?.postTokenBalances ?? []).slice(0, 12).map((p: any) => {
      const before = (tx.meta?.preTokenBalances ?? []).find((b: any) => b.accountIndex === p.accountIndex);
      return { owner: p.owner, mint: p.mint, before: before?.uiTokenAmount?.uiAmountString ?? '0', after: p.uiTokenAmount?.uiAmountString };
    }),
    instructions: (msg.instructions ?? []).slice(0, 12).map((ix: any) => ({ program: ix.program ?? ix.programId, type: ix.parsed?.type ?? null, info: ix.parsed?.info ?? null })),
    logs: (tx.meta?.logMessages ?? []).slice(0, 15),
  };
}

export async function solanaRead(rpc: Rpc, method: string, args: Record<string, unknown>, allowed: string[]): Promise<unknown> {
  if (!allowed.includes(method)) throw new ChainArgError(`method ${method} is not available to this agent`);
  switch (method) {
    case 'getBalance': {
      const r = await rpc.call('getBalance', [addr(args.address, 'address'), { commitment: 'confirmed' }]);
      const lamports = Number(r?.value ?? 0);
      return { lamports, sol: lamports / 1e9 };
    }
    case 'getAccountInfo': {
      const r = await rpc.call('getAccountInfo', [addr(args.address, 'address'), { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      const v = r?.value;
      if (!v) return { exists: false };
      const data = Array.isArray(v.data)
        ? { encoding: v.data[1], bytes: Buffer.from(v.data[0], 'base64').length }
        : { program: v.data?.program, type: v.data?.parsed?.type ?? null, info: v.data?.parsed?.info ?? null };
      return { exists: true, owner: v.owner, lamports: v.lamports, executable: v.executable, data };
    }
    case 'getTokenSupply': {
      const r = await rpc.call('getTokenSupply', [addr(args.mint, 'mint'), { commitment: 'confirmed' }]);
      return r?.value ?? null;
    }
    case 'getTokenLargestAccounts': {
      const r = await rpc.call('getTokenLargestAccounts', [addr(args.mint, 'mint'), { commitment: 'confirmed' }]);
      return (r?.value ?? []).slice(0, 20).map((a: any) => ({ address: a.address, amount: a.uiAmountString ?? String(a.uiAmount) }));
    }
    case 'getTokenAccountsByOwner': {
      const owner = addr(args.owner, 'owner');
      const out: any[] = [];
      for (const programId of [TOKEN, TOKEN_2022]) {
        const r = await rpc.call('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
        for (const a of r?.value ?? []) {
          const info = a.account?.data?.parsed?.info;
          if (info) out.push({ mint: info.mint, amount: info.tokenAmount?.uiAmountString, program: programId === TOKEN ? 'token' : 'token-2022' });
        }
      }
      return out.slice(0, 40);
    }
    case 'getSignaturesForAddress': {
      const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 20);
      const r = await rpc.call('getSignaturesForAddress', [addr(args.address, 'address'), { limit, commitment: 'confirmed' }]);
      return (r ?? []).map((s: any) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime, error: s.err ? true : false, memo: s.memo ?? null }));
    }
    case 'getTransaction': {
      const sig = String(args.signature ?? '').trim();
      if (!SIG_RE.test(sig)) throw new ChainArgError('signature is not a transaction signature');
      const r = await rpc.call('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      return trimTx(r);
    }
    case 'pumpCurve': {
      const mint = new PublicKey(addr(args.mint, 'mint'));
      const r = await rpc.call('getAccountInfo', [bondingCurvePda(mint).toBase58(), { encoding: 'base64', commitment: 'confirmed' }]);
      if (!r?.value) return { found: false };
      const c = decodeCurve(Buffer.from(r.value.data[0], 'base64'));
      return {
        found: true,
        complete: c.complete,
        creator: c.creator.toBase58(),
        marketCapSol: Number(curveMarketCapLamports(c)) / 1e9,
        progressPct: curveProgressBps(c.realTokenReserves, c.complete) / 100,
        realSolReserves: Number(c.realQuoteReserves) / 1e9,
      };
    }
    default:
      throw new ChainArgError(`unknown method ${method}`);
  }
}

export const SOLANA_TOOL_PARAMS = {
  type: 'object',
  properties: {
    method: { type: 'string', description: 'The read to make.' },
    address: { type: 'string', description: 'A wallet or account address, for getBalance, getAccountInfo and getSignaturesForAddress.' },
    mint: { type: 'string', description: 'A token mint address, for getTokenSupply, getTokenLargestAccounts and pumpCurve.' },
    owner: { type: 'string', description: 'A wallet address, for getTokenAccountsByOwner.' },
    signature: { type: 'string', description: 'A transaction signature, for getTransaction.' },
    limit: { type: 'integer', description: 'How many signatures, 1 to 20.' },
  },
  required: ['method'],
};
