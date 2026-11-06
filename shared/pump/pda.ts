import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { ATA_PROGRAM, MAYHEM_PROGRAM, PUMP_AMM_PROGRAM, PUMP_FEES_PROGRAM, PUMP_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from "./constants";

const seed = (s: string) => Buffer.from(s);
const pda = (seeds: Buffer[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

export const GLOBAL = pda([seed("global")], PUMP_PROGRAM);
export const MINT_AUTHORITY = pda([seed("mint-authority")], PUMP_PROGRAM);
export const EVENT_AUTHORITY = pda([seed("__event_authority")], PUMP_PROGRAM);
export const FEE_CONFIG = pda([seed("fee_config"), PUMP_PROGRAM.toBuffer()], PUMP_FEES_PROGRAM);
export const MAYHEM_GLOBAL_PARAMS = pda([seed("global-params")], MAYHEM_PROGRAM);
export const MAYHEM_SOL_VAULT = pda([seed("sol-vault")], MAYHEM_PROGRAM);
export const AMM_GLOBAL_CONFIG = pda([seed("global_config")], PUMP_AMM_PROGRAM);
export const AMM_EVENT_AUTHORITY = pda([seed("__event_authority")], PUMP_AMM_PROGRAM);
export const AMM_FEE_CONFIG = pda([seed("fee_config"), PUMP_AMM_PROGRAM.toBuffer()], PUMP_FEES_PROGRAM);

export const bondingCurvePda = (mint: PublicKey) => pda([seed("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM);
export const creatorVaultPda = (creator: PublicKey) => pda([seed("creator-vault"), creator.toBuffer()], PUMP_PROGRAM);
export const userVolumePda = (user: PublicKey) => pda([seed("user_volume_accumulator"), user.toBuffer()], PUMP_PROGRAM);
export const mayhemStatePda = (mint: PublicKey) => pda([seed("mayhem-state"), mint.toBuffer()], MAYHEM_PROGRAM);
export const ammUserVolumePda = (user: PublicKey) => pda([seed("user_volume_accumulator"), user.toBuffer()], PUMP_AMM_PROGRAM);
export const ammCreatorVaultPda = (creator: PublicKey) => pda([seed("creator_vault"), creator.toBuffer()], PUMP_AMM_PROGRAM);
export const poolAuthorityPda = (mint: PublicKey) => pda([seed("pool-authority"), mint.toBuffer()], PUMP_PROGRAM);

export function ataAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_2022_PROGRAM): PublicKey {
  return pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
}

/** The canonical pool a graduated coin lives in: index 0, created by the coin's pool authority, paired with wrapped SOL. */
export function canonicalPoolPda(mint: PublicKey): PublicKey {
  const index = Buffer.alloc(2);
  index.writeUInt16LE(0, 0);
  return pda([seed("pool"), index, poolAuthorityPda(mint).toBuffer(), mint.toBuffer(), WSOL_MINT.toBuffer()], PUMP_AMM_PROGRAM);
}

export const wsolAta = (owner: PublicKey) => ataAddress(owner, WSOL_MINT, TOKEN_PROGRAM);
