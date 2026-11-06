import { PublicKey } from "@solana/web3.js";

export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_AMM_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const PUMP_FEES_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const MAYHEM_PROGRAM = new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
export const COMPUTE_BUDGET_PROGRAM = new PublicKey("ComputeBudget111111111111111111111111111111");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/** The eight wallets create_v2 coins may pay the buyback slice to. Checked against the live Global by scripts/simulate-mainnet.mts. */
export const BUYBACK_RECIPIENTS = [
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
  "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
  "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
  "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
  "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
  "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
  "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
].map((a) => new PublicKey(a));

/** Curve opening state read from the live Global account on 2 Nov 2026. */
export const CURVE_DEFAULTS = {
  virtualTokenReserves: 1_073_000_000_000_000n,
  virtualQuoteReserves: 30_000_000_000n,
  realTokenReserves: 793_100_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
};
export const TOKEN_DECIMALS = 6;
export const ONE_TOKEN = 1_000_000n;

/** Name, symbol and uri limits enforced by create_v2. */
export const NAME_MAX = 32;
export const SYMBOL_MAX = 13;
export const URI_MAX = 200;

/** Instruction discriminators, compared with the vendored IDL in test/pump-idl.test.ts. */
export const DISC = {
  createV2: [214, 144, 76, 236, 95, 139, 49, 180],
  buyExactQuoteInV3: [225, 247, 80, 30, 213, 179, 132, 136],
  buyV3: [7, 5, 29, 196, 245, 23, 101, 80],
  sweepCreatorFee: [32, 246, 191, 52, 8, 201, 73, 186],
  collectCreatorFeeV2: [207, 17, 138, 242, 4, 34, 19, 56],
  ammBuyV2: [184, 23, 238, 97, 103, 197, 211, 61],
  ammSweepCreatorFee: [32, 246, 191, 52, 8, 201, 73, 186],
  collectCoinCreatorFee: [160, 57, 89, 42, 181, 139, 43, 66],
} as const;

export const ACCOUNT_DISC = {
  bondingCurve: [23, 183, 248, 55, 96, 216, 172, 96],
  pool: [241, 154, 109, 4, 17, 177, 109, 188],
} as const;

export const TRADE_EVENT_DISC = [189, 219, 127, 211, 78, 230, 97, 238];
