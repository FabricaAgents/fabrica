// Every setting the process reads, in one place. docs/SETTINGS.md lists each one.
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import type { HolderTier, PaymentRequirements } from '../shared/types';

export const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface Config {
  port: number;
  dev: boolean;
  dataDir: string;
  siteUrl: string;
  xUrl: string | null;
  aiMode: 'openrouter' | 'fake' | 'offline';
  openrouterKey: string | null;
  openrouterBase: string;
  rpcUrls: string[];
  /** Helius, used only when every free node failed a call. */
  backupRpc: string | null;
  wsUrl: string | null;
  heliusKey: string | null;
  network: PaymentRequirements['network'];
  usdcMint: string;
  opsWallet: string | null;
  burnWallet: string | null;
  burnSecret: string | null;
  mint: string | null;
  adminToken: string | null;
  platformFeeBps: number;
  platformFeeMinMicros: number;
  buildFeeMicros: number;
  buildAiBudgetMicros: number;
  dailyAiCapMicros: number;
  agentDailyAiCapMicros: number;
  trustProxyHops: number;
  testMode: boolean;
  jupiterUrl: string;
  tiers: HolderTier[] | null;
  baseTier: HolderTier;
  burnMinMicros: number;
  fixturesDir: string;
  /** REMIX=off hides the Remix buttons and refuses new remixes. Live remixes keep running and paying royalties. */
  remixOpen: boolean;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};

const str = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

function wallet(name: string, v: string | undefined): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    return new PublicKey(s).toBase58();
  } catch {
    throw new Error(`${name} is not a valid Solana address`);
  }
}

export const BASE_TIER: HolderTier = { name: 'Maker', minTokens: 0, liveAgents: 3, buildDiscountBps: 0, feeDiscountBps: 0, earlyAccess: false };

function parseTiers(raw: string | undefined): HolderTier[] | null {
  const s = str(raw);
  if (!s) return null;
  const list = JSON.parse(s) as HolderTier[];
  if (!Array.isArray(list) || !list.length) throw new Error('FABRICA_TIERS must be a JSON array');
  for (const t of list) {
    if (!t.name || !(t.minTokens > 0)) throw new Error('every tier needs a name and minTokens above zero');
  }
  return list.sort((a, b) => a.minTokens - b.minTokens);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dev = env.FABRICA_DEV === '1';
  const testMode = env.FABRICA_TEST_MODE === '1';
  if (testMode && (env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID)) {
    throw new Error('FABRICA_TEST_MODE runs a pretend chain and must never be set on Railway');
  }
  const port = num(env.PORT, 3721);
  const heliusKey = str(env.HELIUS_API_KEY);
  const extraRpc = str(env.SOLANA_RPC_URL);
  // Free nodes do the work. Helius is only the backup for a call every free node failed, and never the live stream,
  // so the key's monthly credits last.
  const rpcUrls = [...(extraRpc ? [extraRpc] : []), 'https://api.mainnet-beta.solana.com'];
  const backupRpc = heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : null;
  const wsUrl = str(env.SOLANA_WS_URL) ?? 'wss://api.mainnet-beta.solana.com';
  const openrouterKey = str(env.OPENROUTER_API_KEY);
  const forced = str(env.FABRICA_AI_MODE);
  let aiMode: Config['aiMode'];
  if (forced === 'fake' || forced === 'openrouter' || forced === 'offline') aiMode = forced;
  else aiMode = openrouterKey ? 'openrouter' : dev || testMode ? 'fake' : 'offline';
  if (aiMode === 'openrouter' && !openrouterKey) throw new Error('FABRICA_AI_MODE=openrouter needs OPENROUTER_API_KEY');
  const network = (str(env.FABRICA_NETWORK) ?? (testMode ? 'solana-localnet' : 'solana')) as Config['network'];
  return {
    port,
    dev,
    dataDir: path.resolve(str(env.FABRICA_DATA_DIR) ?? path.join(process.cwd(), 'data')),
    siteUrl: (str(env.FABRICA_SITE_URL) ?? `http://localhost:${port}`).replace(/\/$/, ''),
    xUrl: str(env.FABRICA_X_URL),
    aiMode,
    openrouterKey,
    openrouterBase: str(env.OPENROUTER_BASE_URL) ?? 'https://openrouter.ai/api/v1',
    rpcUrls,
    backupRpc,
    wsUrl,
    heliusKey,
    network,
    usdcMint: wallet('FABRICA_USDC_MINT', env.FABRICA_USDC_MINT) ?? USDC_MAINNET,
    opsWallet: wallet('FABRICA_OPS_WALLET', env.FABRICA_OPS_WALLET),
    burnWallet: wallet('FABRICA_BURN_WALLET', env.FABRICA_BURN_WALLET),
    burnSecret: str(env.FABRICA_BURN_SECRET),
    mint: wallet('FABRICA_MINT', env.FABRICA_MINT),
    adminToken: str(env.FABRICA_ADMIN_TOKEN),
    platformFeeBps: num(env.FABRICA_PLATFORM_FEE_BPS, 1000),
    platformFeeMinMicros: Math.round(num(env.FABRICA_PLATFORM_FEE_MIN_USD, 0.002) * 1e6),
    buildFeeMicros: Math.round(num(env.FABRICA_BUILD_FEE_USD, 0.5) * 1e6),
    buildAiBudgetMicros: Math.round(num(env.FABRICA_BUILD_FEE_USD, 0.5) * 1e6 * 0.9),
    dailyAiCapMicros: Math.round(num(env.FABRICA_DAILY_AI_CAP_USD, 25) * 1e6),
    agentDailyAiCapMicros: Math.round(num(env.FABRICA_AGENT_DAILY_AI_CAP_USD, 5) * 1e6),
    trustProxyHops: num(env.FABRICA_TRUST_PROXY_HOPS, env.RAILWAY_ENVIRONMENT ? 1 : 0),
    testMode,
    jupiterUrl: (str(env.JUPITER_API_URL) ?? 'https://lite-api.jup.ag/swap/v1').replace(/\/$/, ''),
    tiers: parseTiers(env.FABRICA_TIERS),
    baseTier: BASE_TIER,
    burnMinMicros: Math.round(num(env.FABRICA_BURN_MIN_USD, 5) * 1e6),
    fixturesDir: path.join(process.cwd(), 'fixtures'),
    remixOpen: (str(env.REMIX) ?? 'on').toLowerCase() !== 'off',
  };
}
