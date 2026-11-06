import { CURVE_DEFAULTS } from "./constants";

export interface Reserves {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
}

/** The fee a fresh SOL-paired coin pays on a trade, from the live fee_config lowest tier (95 + 30 bps). */
export const FIRST_TIER_FEE_BPS = 125n;
/** A generous ceiling used for the minimum-out guard, so a schedule change does not fail the launch. */
export const GUARD_FEE_BPS = 400n;

export function tokensForNet(net: bigint, r: Reserves = CURVE_DEFAULTS): bigint {
  if (net <= 1n) return 0n;
  const input = net - 1n;
  return (input * r.virtualTokenReserves) / (r.virtualQuoteReserves + input);
}

export function netOfFees(spendable: bigint, feeBps: bigint): bigint {
  return (spendable * 10_000n) / (10_000n + feeBps);
}

/** Tokens a budget buys on a curve, at a given total fee. */
export function tokensForSpend(spendable: bigint, r: Reserves = CURVE_DEFAULTS, feeBps: bigint = FIRST_TIER_FEE_BPS): bigint {
  return tokensForNet(netOfFees(spendable, feeBps), r);
}

/**
 * Minimum tokens for a first buy. Nothing can trade between the create and the
 * buy in one bundle, so this only guards against a fee schedule change.
 */
export function minTokensForFirstBuy(spendable: bigint): bigint {
  return (tokensForSpend(spendable, CURVE_DEFAULTS, GUARD_FEE_BPS) * 95n) / 100n;
}

/** Share of total supply a first buy takes, in basis points. */
export function supplyShareBps(spendable: bigint): number {
  return Number((tokensForSpend(spendable) * 10_000n) / CURVE_DEFAULTS.tokenTotalSupply);
}

/** Market cap in lamports: last price times total supply. */
export function curveMarketCapLamports(r: Reserves, totalSupply: bigint = CURVE_DEFAULTS.tokenTotalSupply): bigint {
  if (r.virtualTokenReserves === 0n) return 0n;
  return (r.virtualQuoteReserves * totalSupply) / r.virtualTokenReserves;
}

/** Share of the sellable curve already sold, in basis points. */
export function curveProgressBps(realTokenReserves: bigint, complete: boolean): number {
  if (complete) return 10_000;
  const start = CURVE_DEFAULTS.realTokenReserves;
  if (realTokenReserves >= start) return 0;
  return Number(((start - realTokenReserves) * 10_000n) / start);
}

export function poolTokensOut(spendable: bigint, baseReserve: bigint, quoteReserve: bigint, feeBps = 125n): bigint {
  const net = netOfFees(spendable, feeBps);
  if (net <= 0n || quoteReserve + net <= 0n) return 0n;
  return (baseReserve * net) / (quoteReserve + net);
}
