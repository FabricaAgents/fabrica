// $FABRICA. The platform fee of every paid call lands in the burn wallet in USDC. Once the coin exists and
// FABRICA_BURN_SECRET is set, a keeper swaps what has gathered into $FABRICA and burns it, hourly, and records
// both transactions. Holder extras are read from the chain. Before launch nothing here shows a number.
import { Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import type { HolderTier } from '../../shared/types';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../../shared/pump/constants';
import { burnCheckedInstruction, setComputeLimitInstruction } from '../../shared/pump/instructions';
import { usdcAccount } from '../../shared/pay';
import { audit, kvGet, kvSet } from '../db';
import type { Engine } from '../engine';
import { balanceDelta } from '../coins/jupiter';

const TIER_TTL = 10 * 60_000;

export class TokenDesk {
  private tiers = new Map<string, { tier: HolderTier; at: number; pending?: boolean }>();
  private lastRun: { at: number; result: string } | null = null;
  private running = false;
  private supplyCache: { at: number; value: { amount: string; decimals: number } | null } | null = null;
  constructor(private e: Engine) {}

  get launched(): boolean {
    return Boolean(this.e.cfg.mint);
  }

  /** The tier for a wallet from cache; refreshes in the background. Base tier before launch. */
  cachedTier(wallet: string | null): HolderTier | null {
    const cfg = this.e.cfg;
    if (!wallet || !cfg.mint || !cfg.tiers) return cfg.baseTier;
    const hit = this.tiers.get(wallet);
    if (!hit || (Date.now() - hit.at > TIER_TTL && !hit.pending)) {
      if (hit) hit.pending = true;
      void this.tierFor(wallet).catch(() => {});
    }
    return hit?.tier ?? cfg.baseTier;
  }

  async balanceOf(wallet: string): Promise<number> {
    const r = await this.e.rpc.call('getTokenAccountsByOwner', [wallet, { mint: this.e.cfg.mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    let raw = 0n;
    let decimals = 6;
    for (const a of r?.value ?? []) {
      const amt = a.account?.data?.parsed?.info?.tokenAmount;
      if (amt) {
        raw += BigInt(amt.amount);
        decimals = Number(amt.decimals ?? 6);
      }
    }
    return Number(raw) / 10 ** decimals;
  }

  async tierFor(wallet: string): Promise<HolderTier> {
    const cfg = this.e.cfg;
    if (!cfg.mint || !cfg.tiers) return cfg.baseTier;
    const bal = await this.balanceOf(wallet);
    let tier = cfg.baseTier;
    for (const t of cfg.tiers) if (bal >= t.minTokens) tier = { ...cfg.baseTier, ...t };
    this.tiers.set(wallet, { tier, at: Date.now() });
    return tier;
  }

  status(): string {
    if (!this.e.cfg.mint) return 'waiting for launch';
    if (!this.e.cfg.burnSecret) return 'manual: FABRICA_BURN_SECRET not set';
    return this.lastRun ? `${this.lastRun.result} at ${new Date(this.lastRun.at).toISOString()}` : 'armed';
  }

  async supply() {
    if (!this.e.cfg.mint) return null;
    if (this.supplyCache && Date.now() - this.supplyCache.at < 5 * 60_000) return this.supplyCache.value;
    const r = await this.e.rpc.call('getTokenSupply', [this.e.cfg.mint, { commitment: 'confirmed' }]).catch(() => null);
    const value = r?.value ? { amount: String(r.value.amount), decimals: Number(r.value.decimals) } : null;
    this.supplyCache = { at: Date.now(), value };
    return value;
  }

  /** Public numbers for the token page. Null before launch, so nothing can leak early. */
  async stats() {
    if (!this.e.cfg.mint) return null;
    const burns = this.e.db.prepare("SELECT burn_sig, swap_sig, usdc_spent, tokens_burned, created_at FROM burns WHERE kind = 'fabrica' ORDER BY created_at DESC LIMIT 50").all() as { burn_sig: string; swap_sig: string | null; usdc_spent: number; tokens_burned: string; created_at: number }[];
    const fees = this.e.db.prepare('SELECT COALESCE(SUM(platform_amt),0) AS v, COUNT(*) AS n FROM receipts').get() as { v: number; n: number };
    return {
      mint: this.e.cfg.mint,
      supply: await this.supply(),
      burnedRaw: burns.reduce((n, b) => n + BigInt(b.tokens_burned), 0n).toString(),
      usdcSpent: burns.reduce((n, b) => n + b.usdc_spent, 0),
      platformFees: fees.v,
      paidCalls: fees.n,
      burns,
    };
  }

  /** One keeper pass: swap the burn wallet's USDC into $FABRICA, then burn the whole $FABRICA balance. */
  async burnTick(): Promise<string> {
    const cfg = this.e.cfg;
    if (!cfg.mint || !cfg.burnSecret || !cfg.burnWallet || this.running) return 'skipped';
    this.running = true;
    try {
      const kp = Keypair.fromSecretKey(bs58.decode(cfg.burnSecret));
      if (kp.publicKey.toBase58() !== cfg.burnWallet) throw new Error('FABRICA_BURN_SECRET does not belong to FABRICA_BURN_WALLET');
      const usdcAcct = usdcAccount(kp.publicKey, new PublicKey(cfg.usdcMint)).toBase58();
      const bal = await this.e.rpc.call('getTokenAccountBalance', [usdcAcct, { commitment: 'confirmed' }]).catch(() => null);
      const usdc = BigInt(bal?.value?.amount ?? '0');
      let swapSig: string | null = null;
      let spent = 0;
      if (usdc >= BigInt(cfg.burnMinMicros)) {
        const q = await this.e.coins.jupiter.quote(cfg.usdcMint, cfg.mint, usdc, 200);
        const vt = VersionedTransaction.deserialize(Buffer.from(await this.e.coins.jupiter.swapTransaction(q, cfg.burnWallet), 'base64'));
        vt.sign([kp]);
        swapSig = await this.send(Buffer.from(vt.serialize()).toString('base64'));
        const parsed = await this.wait(swapSig);
        spent = Number(-balanceDelta(parsed, cfg.burnWallet, cfg.usdcMint));
        this.e.db.prepare('INSERT INTO buys (id, kind, mint, swap_sig, usdc_spent, tokens_bought, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(this.e.newId('b'), 'fabrica', cfg.mint, swapSig, spent, balanceDelta(parsed, cfg.burnWallet, cfg.mint).toString(), Date.now());
      }
      // Burn everything the wallet holds of $FABRICA, from either token program.
      const accts = await this.e.rpc.call('getTokenAccountsByOwner', [cfg.burnWallet, { mint: cfg.mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      const a = accts?.value?.[0];
      const amount = BigInt(a?.account?.data?.parsed?.info?.tokenAmount?.amount ?? '0');
      const decimals = Number(a?.account?.data?.parsed?.info?.tokenAmount?.decimals ?? 6);
      if (amount <= 0n) {
        this.lastRun = { at: Date.now(), result: swapSig ? 'bought, nothing to burn yet' : 'nothing to burn' };
        return this.lastRun.result;
      }
      const program = a.account.owner === TOKEN_2022_PROGRAM.toBase58() ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
      const { blockhash } = (await this.e.rpc.call('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
      const t = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash });
      t.add(setComputeLimitInstruction(60_000), burnCheckedInstruction(kp.publicKey, new PublicKey(cfg.mint), amount, decimals, program));
      t.sign(kp);
      const burnSig = await this.send(t.serialize().toString('base64'));
      await this.wait(burnSig);
      const open = this.e.db.prepare("SELECT COALESCE(SUM(usdc_spent),0) AS v FROM buys WHERE kind = 'fabrica' AND burned = 0").get() as { v: number };
      this.e.db.prepare("UPDATE buys SET burned = 1 WHERE kind = 'fabrica' AND burned = 0").run();
      this.e.db.prepare('INSERT INTO burns (id, kind, mint, swap_sig, burn_sig, usdc_spent, tokens_burned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(this.e.newId('u'), 'fabrica', cfg.mint, swapSig, burnSig, open.v, amount.toString(), Date.now());
      audit(this.e.db, 'keeper', 'fabrica_burn', { swapSig, burnSig, amount: amount.toString(), usdc: open.v });
      kvSet(this.e.db, 'last_burn', String(Date.now()));
      this.lastRun = { at: Date.now(), result: 'burned' };
      return 'burned';
    } catch (err) {
      this.lastRun = { at: Date.now(), result: `failed: ${(err as Error).message.slice(0, 120)}` };
      this.e.log(`burn keeper: ${(err as Error).message}`);
      return this.lastRun.result;
    } finally {
      this.running = false;
    }
  }

  private async send(b64: string): Promise<string> {
    return this.e.rpc.call('sendTransaction', [b64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 }]);
  }

  private async wait(sig: string): Promise<any> {
    for (let i = 0; i < 60; i++) {
      const tx = await this.e.rpc.call('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
      if (tx) {
        if (tx.meta?.err) throw new Error(`transaction ${sig} failed on chain`);
        return tx;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`transaction ${sig} did not confirm`);
  }

  /**
   * Records a burn the owner made by hand from the burn wallet (when no keeper key is on the server).
   * Only a confirmed burnChecked of $FABRICA signed by the burn wallet is accepted.
   */
  async recordManualBurn(sig: string): Promise<{ burned: string }> {
    const cfg = this.e.cfg;
    if (!cfg.mint || !cfg.burnWallet) throw new Error('Set FABRICA_MINT and FABRICA_BURN_WALLET first.');
    if (this.e.db.prepare('SELECT 1 FROM burns WHERE burn_sig = ?').get(sig)) throw new Error('That burn is already recorded.');
    const tx = await this.wait(sig);
    const amount = (tx.transaction?.message?.instructions ?? [])
      .filter((ix: any) => ix.parsed?.type === 'burnChecked' && ix.parsed.info?.mint === cfg.mint && ix.parsed.info?.authority === cfg.burnWallet)
      .reduce((n: bigint, ix: any) => n + BigInt(ix.parsed.info.tokenAmount.amount), 0n);
    if (amount <= 0n) throw new Error('That transaction does not burn $FABRICA from the burn wallet.');
    const spent = -balanceDelta(tx, cfg.burnWallet, cfg.usdcMint);
    this.e.db.prepare('INSERT INTO burns (id, kind, mint, burn_sig, usdc_spent, tokens_burned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(this.e.newId('u'), 'fabrica', cfg.mint, sig, Number(spent > 0n ? spent : 0n), amount.toString(), Date.now());
    audit(this.e.db, 'admin', 'fabrica_burn_manual', { sig, amount: amount.toString() });
    return { burned: amount.toString() };
  }

  lastBurnAt(): number | null {
    const v = kvGet(this.e.db, 'last_burn');
    return v ? Number(v) : null;
  }
}
