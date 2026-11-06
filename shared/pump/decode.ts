import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { ACCOUNT_DISC, TRADE_EVENT_DISC } from "./constants";

export interface Curve {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: PublicKey;
  /** Creator fee kept on the curve by v3 trades. Zero on older, shorter accounts. */
  creatorFeeWaiting: bigint;
}

const matches = (data: Buffer, disc: readonly number[]) => disc.every((v, i) => data[i] === v);

export function decodeCurve(data: Buffer): Curve {
  if (data.length < 81 || !matches(data, ACCOUNT_DISC.bondingCurve)) throw new Error("not a bonding curve account");
  let o = 8;
  const u = () => {
    const v = data.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  const virtualTokenReserves = u();
  const virtualQuoteReserves = u();
  const realTokenReserves = u();
  const realQuoteReserves = u();
  const tokenTotalSupply = u();
  const complete = data[o++] === 1;
  const creator = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  // is_mayhem_mode, is_cashback_coin, quote_mint, creator_fee_bps, can_edit, is_holder_reward
  o += 1 + 1 + 32 + 8 + 1 + 1;
  const creatorFeeWaiting = data.length >= o + 8 ? data.readBigUInt64LE(o) : 0n;
  return { virtualTokenReserves, virtualQuoteReserves, realTokenReserves, realQuoteReserves, tokenTotalSupply, complete, creator, creatorFeeWaiting };
}

export interface Pool {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  poolBase: PublicKey;
  poolQuote: PublicKey;
  coinCreator: PublicKey;
  virtualQuoteReserves: bigint;
  creatorFeesWaiting: bigint;
}

export function decodePool(data: Buffer): Pool {
  if (data.length < 8 + 3 + 32 * 6 + 8 + 32 || !matches(data, ACCOUNT_DISC.pool)) throw new Error("not a pool account");
  let o = 8 + 1 + 2 + 32;
  const pk = () => {
    const p = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    return p;
  };
  const baseMint = pk();
  const quoteMint = pk();
  o += 32; // lp_mint
  const poolBase = pk();
  const poolQuote = pk();
  o += 8; // lp_supply
  const coinCreator = pk();
  o += 2; // is_mayhem_mode, is_cashback_coin
  let virtualQuoteReserves = 0n;
  if (data.length >= o + 16) {
    const lo = data.readBigUInt64LE(o);
    const hi = data.readBigInt64LE(o + 8);
    virtualQuoteReserves = (hi << 64n) + lo;
  }
  o += 16 + 8 + 1 + 1 + 8; // virtual_quote, creator_fee_bps, can_edit, is_holder_reward, protocol_fees
  const creatorFeesWaiting = data.length >= o + 8 ? data.readBigUInt64LE(o) : 0n;
  return { baseMint, quoteMint, poolBase, poolQuote, coinCreator, virtualQuoteReserves, creatorFeesWaiting };
}

/** Token account amount: the u64 at offset 64 for both token programs. */
export function decodeTokenAmount(data: Buffer): bigint {
  if (data.length < 72) return 0n;
  return data.readBigUInt64LE(64);
}

/** Mint supply and decimals: same offsets for both token programs. */
export function decodeMint(data: Buffer): { supply: bigint; decimals: number } {
  if (data.length < 45) throw new Error("not a mint account");
  return { supply: data.readBigUInt64LE(36), decimals: data[44] };
}

export interface TradeEvent {
  mint: string;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: string;
  timestamp: number;
  virtualQuoteReserves: bigint;
  virtualTokenReserves: bigint;
  realQuoteReserves: bigint;
  realTokenReserves: bigint;
}

/** Decodes a pump TradeEvent from the payload of a "Program data:" log line. Returns null for anything else. */
export function decodeTradeEvent(base64: string): TradeEvent | null {
  const d = Buffer.from(base64, "base64");
  if (d.length < 8 + 32 + 8 + 8 + 1 + 32 + 8 + 32 || !matches(d, TRADE_EVENT_DISC)) return null;
  let o = 8;
  const mint = new PublicKey(d.subarray(o, o + 32)).toBase58();
  o += 32;
  const solAmount = d.readBigUInt64LE(o);
  o += 8;
  const tokenAmount = d.readBigUInt64LE(o);
  o += 8;
  const isBuy = d[o++] === 1;
  const user = new PublicKey(d.subarray(o, o + 32)).toBase58();
  o += 32;
  const timestamp = Number(d.readBigInt64LE(o));
  o += 8;
  const virtualQuoteReserves = d.readBigUInt64LE(o);
  o += 8;
  const virtualTokenReserves = d.readBigUInt64LE(o);
  o += 8;
  const realQuoteReserves = d.readBigUInt64LE(o);
  o += 8;
  const realTokenReserves = d.readBigUInt64LE(o);
  return { mint, solAmount, tokenAmount, isBuy, user, timestamp, virtualQuoteReserves, virtualTokenReserves, realQuoteReserves, realTokenReserves };
}

export function tradeEventsFromLogs(logs: string[]): TradeEvent[] {
  const out: TradeEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const ev = decodeTradeEvent(line.slice("Program data: ".length).trim());
    if (ev) out.push(ev);
  }
  return out;
}
