import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { Buffer } from "buffer";
import {
  ATA_PROGRAM,
  BUYBACK_RECIPIENTS,
  COMPUTE_BUDGET_PROGRAM,
  DISC,
  MAYHEM_PROGRAM,
  NAME_MAX,
  PUMP_AMM_PROGRAM,
  PUMP_PROGRAM,
  SYMBOL_MAX,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  URI_MAX,
  WSOL_MINT,
} from "./constants";
import {
  AMM_EVENT_AUTHORITY,
  AMM_FEE_CONFIG,
  AMM_GLOBAL_CONFIG,
  EVENT_AUTHORITY,
  FEE_CONFIG,
  GLOBAL,
  MAYHEM_GLOBAL_PARAMS,
  MAYHEM_SOL_VAULT,
  MINT_AUTHORITY,
  ammCreatorVaultPda,
  ammUserVolumePda,
  ataAddress,
  bondingCurvePda,
  creatorVaultPda,
  mayhemStatePda,
  userVolumePda,
  wsolAta,
} from "./pda";

const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const signer = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: true });

const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
};
const borshString = (s: string) => {
  const bytes = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
};
const flag = (v: boolean) => Buffer.from([v ? 1 : 0]);

export function buybackRecipientFor(mint: PublicKey): PublicKey {
  return BUYBACK_RECIPIENTS[mint.toBytes()[0] % BUYBACK_RECIPIENTS.length];
}

export interface CreateV2Args {
  mint: PublicKey;
  user: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}

/** create_v2 on a plain SOL pair. No mayhem, no cashback, no holder rewards: the creator is the launch wallet. */
export function createV2Instruction({ mint, user, name, symbol, uri }: CreateV2Args): TransactionInstruction {
  if ([...name].length > NAME_MAX) throw new Error("name too long");
  if ([...symbol].length > SYMBOL_MAX) throw new Error("ticker too long");
  if (uri.length > URI_MAX) throw new Error("uri too long");
  const bondingCurve = bondingCurvePda(mint);
  const keys: AccountMeta[] = [
    signer(mint),
    ro(MINT_AUTHORITY),
    rw(bondingCurve),
    rw(ataAddress(bondingCurve, mint)),
    ro(GLOBAL),
    signer(user),
    ro(SYSTEM_PROGRAM),
    ro(TOKEN_2022_PROGRAM),
    ro(ATA_PROGRAM),
    rw(MAYHEM_PROGRAM),
    ro(MAYHEM_GLOBAL_PARAMS),
    rw(MAYHEM_SOL_VAULT),
    rw(mayhemStatePda(mint)),
    rw(ataAddress(MAYHEM_SOL_VAULT, mint)),
    ro(EVENT_AUTHORITY),
    ro(PUMP_PROGRAM),
  ];
  const data = Buffer.concat([
    Buffer.from(DISC.createV2),
    borshString(name),
    borshString(symbol),
    borshString(uri),
    user.toBuffer(),
    flag(false), // is_mayhem_mode
    flag(false), // is_cashback_enabled
    u64(0n), // creator_fee_bps
    flag(false), // is_holder_reward
  ]);
  return new TransactionInstruction({ programId: PUMP_PROGRAM, keys, data });
}

export function createAtaIdempotentInstruction(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_2022_PROGRAM): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [signer(payer), rw(ataAddress(owner, mint, tokenProgram)), ro(owner), ro(mint), ro(SYSTEM_PROGRAM), ro(tokenProgram)],
    data: Buffer.from([1]),
  });
}

function tradeV3Keys(user: PublicKey, mint: PublicKey, tokenProgram: PublicKey): AccountMeta[] {
  const bondingCurve = bondingCurvePda(mint);
  return [
    ro(GLOBAL),
    ro(mint),
    ro(WSOL_MINT),
    ro(tokenProgram),
    ro(TOKEN_PROGRAM),
    rw(bondingCurve),
    rw(ataAddress(bondingCurve, mint, tokenProgram)),
    rw(wsolAta(bondingCurve)),
    signer(user),
    rw(ataAddress(user, mint, tokenProgram)),
    rw(wsolAta(user)),
    rw(userVolumePda(user)),
    ro(FEE_CONFIG),
    rw(buybackRecipientFor(mint)),
    ro(SYSTEM_PROGRAM),
    ro(EVENT_AUTHORITY),
    ro(PUMP_PROGRAM),
  ];
}

/** Spends exactly spendable lamports, fees included. The first buy uses this. */
export function buyExactQuoteInV3Instruction(user: PublicKey, mint: PublicKey, spendable: bigint, minTokensOut: bigint, tokenProgram: PublicKey = TOKEN_2022_PROGRAM): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: tradeV3Keys(user, mint, tokenProgram),
    data: Buffer.concat([Buffer.from(DISC.buyExactQuoteInV3), u64(spendable), u64(minTokensOut), flag(false)]),
  });
}

/** Buys an exact token amount. The burn job uses this so the burn in the same transaction knows its amount. */
export function buyV3Instruction(user: PublicKey, mint: PublicKey, amount: bigint, maxSolCost: bigint, tokenProgram: PublicKey = TOKEN_2022_PROGRAM): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: tradeV3Keys(user, mint, tokenProgram),
    data: Buffer.concat([Buffer.from(DISC.buyV3), u64(amount), u64(maxSolCost), flag(false)]),
  });
}

/** Moves the creator fee kept on the curve into the creator vault. Permissionless; payer only covers rent top-ups. */
export function sweepCreatorFeeInstruction(payer: PublicKey, mint: PublicKey, creator: PublicKey): TransactionInstruction {
  const bondingCurve = bondingCurvePda(mint);
  const vault = creatorVaultPda(creator);
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      signer(payer),
      ro(GLOBAL),
      ro(mint),
      ro(WSOL_MINT),
      ro(TOKEN_PROGRAM),
      ro(ATA_PROGRAM),
      ro(SYSTEM_PROGRAM),
      rw(bondingCurve),
      rw(wsolAta(bondingCurve)),
      rw(vault),
      rw(wsolAta(vault)),
      ro(EVENT_AUTHORITY),
      ro(PUMP_PROGRAM),
    ],
    data: Buffer.from(DISC.sweepCreatorFee),
  });
}

export function collectCreatorFeeV2Instruction(creator: PublicKey): TransactionInstruction {
  const vault = creatorVaultPda(creator);
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      rw(creator),
      rw(wsolAta(creator)),
      rw(vault),
      rw(wsolAta(vault)),
      ro(WSOL_MINT),
      ro(TOKEN_PROGRAM),
      ro(ATA_PROGRAM),
      ro(SYSTEM_PROGRAM),
      ro(EVENT_AUTHORITY),
      ro(PUMP_PROGRAM),
    ],
    data: Buffer.from(DISC.collectCreatorFeeV2),
  });
}

export interface PoolKeys {
  pool: PublicKey;
  baseMint: PublicKey;
  poolBase: PublicKey;
  poolQuote: PublicKey;
  coinCreator: PublicKey;
}

export function ammSweepCreatorFeeInstruction(payer: PublicKey, pool: PoolKeys): TransactionInstruction {
  const authority = ammCreatorVaultPda(pool.coinCreator);
  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM,
    keys: [
      signer(payer),
      ro(AMM_GLOBAL_CONFIG),
      rw(pool.pool),
      ro(WSOL_MINT),
      ro(TOKEN_PROGRAM),
      rw(pool.poolQuote),
      ro(authority),
      rw(wsolAta(authority)),
      ro(SYSTEM_PROGRAM),
      ro(ATA_PROGRAM),
      ro(AMM_EVENT_AUTHORITY),
      ro(PUMP_AMM_PROGRAM),
    ],
    data: Buffer.from(DISC.ammSweepCreatorFee),
  });
}

export function collectCoinCreatorFeeInstruction(creator: PublicKey): TransactionInstruction {
  const authority = ammCreatorVaultPda(creator);
  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM,
    keys: [
      ro(WSOL_MINT),
      ro(TOKEN_PROGRAM),
      ro(creator),
      ro(authority),
      rw(wsolAta(authority)),
      rw(wsolAta(creator)),
      ro(AMM_EVENT_AUTHORITY),
      ro(PUMP_AMM_PROGRAM),
    ],
    data: Buffer.from(DISC.collectCoinCreatorFee),
  });
}

export function ammBuyV2Instruction(user: PublicKey, pool: PoolKeys, baseAmountOut: bigint, maxQuoteIn: bigint, baseTokenProgram: PublicKey = TOKEN_2022_PROGRAM): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM,
    keys: [
      rw(pool.pool),
      signer(user),
      ro(AMM_GLOBAL_CONFIG),
      ro(pool.baseMint),
      ro(WSOL_MINT),
      rw(ataAddress(user, pool.baseMint, baseTokenProgram)),
      rw(wsolAta(user)),
      rw(pool.poolBase),
      rw(pool.poolQuote),
      ro(baseTokenProgram),
      ro(TOKEN_PROGRAM),
      ro(SYSTEM_PROGRAM),
      rw(ammUserVolumePda(user)),
      ro(AMM_FEE_CONFIG),
      rw(wsolAta(buybackRecipientFor(pool.baseMint))),
      ro(AMM_EVENT_AUTHORITY),
      ro(PUMP_AMM_PROGRAM),
    ],
    data: Buffer.concat([Buffer.from(DISC.ammBuyV2), u64(baseAmountOut), u64(maxQuoteIn)]),
  });
}

/** SPL BurnChecked (index 15). Works for Token and Token-2022 and lowers the mint supply. */
export function burnCheckedInstruction(owner: PublicKey, mint: PublicKey, amount: bigint, decimals: number, tokenProgram: PublicKey = TOKEN_2022_PROGRAM): TransactionInstruction {
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [rw(ataAddress(owner, mint, tokenProgram)), rw(mint), { pubkey: owner, isSigner: true, isWritable: false }],
    data: Buffer.concat([Buffer.from([15]), u64(amount), Buffer.from([decimals])]),
  });
}

/** SPL SyncNative (index 17), so lamports moved to a wrapped SOL account count as balance. */
export function syncNativeInstruction(account: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [rw(account)], data: Buffer.from([17]) });
}

/** SPL CloseAccount (index 9), which turns leftover wrapped SOL back into plain SOL. */
export function closeTokenAccountInstruction(account: PublicKey, destination: PublicKey, owner: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM): TransactionInstruction {
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [rw(account), rw(destination), { pubkey: owner, isSigner: true, isWritable: false }],
    data: Buffer.from([9]),
  });
}

export function setComputeLimitInstruction(units: number): TransactionInstruction {
  const data = Buffer.alloc(5);
  data.writeUInt8(2, 0);
  data.writeUInt32LE(units, 1);
  return new TransactionInstruction({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data });
}

export const transferInstruction = (from: PublicKey, to: PublicKey, lamports: bigint) =>
  SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
