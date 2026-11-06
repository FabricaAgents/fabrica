// Agent coins. The maker launches the coin on pump.fun from their own wallet: the browser builds the create
// transaction, the maker signs and pays, and Fabrica only serves the metadata and checks the result on chain.
// The buyback rule is the maker's promise, shown with what was set aside, bought and burned, each checked on chain.
import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { audit, kvGet, kvSet } from '../db';
import type { Engine } from '../engine';
import type { AgentRow } from '../agents';
import { PUMP_PROGRAM } from '../../shared/pump/constants';
import { bondingCurvePda } from '../../shared/pump/pda';
import { decodeCurve } from '../../shared/pump/decode';
import { curveMarketCapLamports, curveProgressBps } from '../../shared/pump/math';
import { ADDR_RE, SIG_RE } from '../solana/rpc';
import { balanceDelta, Jupiter } from './jupiter';

export class CoinError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface CoinMeta {
  name: string;
  symbol: string;
  description: string;
}

export const BUYBACK_MAX_BPS = 5000;

export class Coins {
  readonly jupiter: Jupiter;
  constructor(private e: Engine) {
    this.jupiter = new Jupiter(e.cfg.jupiterUrl);
  }

  private owned(row: AgentRow | null, maker: string): AgentRow {
    if (!row || row.example) throw new CoinError('No such agent.', 404);
    if (row.maker !== maker) throw new CoinError('Only the maker of this agent can do that.', 403);
    return row;
  }

  meta(row: AgentRow): (CoinMeta & { image: string; website: string }) | null {
    const raw = row.coin_mint ? { name: row.coin_name ?? '', symbol: row.coin_symbol ?? '', description: '' } : null;
    const pending = kvGet(this.e.db, `coinmeta:${row.id}`);
    const m: CoinMeta | null = pending ? JSON.parse(pending) : raw;
    if (!m) return null;
    return { ...m, image: `${this.e.cfg.siteUrl}/coin-image/${row.slug}`, website: `${this.e.cfg.siteUrl}/agents/${row.slug}` };
  }

  prepare(slug: string, maker: string, body: any): { uri: string; name: string; symbol: string } {
    const row = this.owned(this.e.agents.row(slug), maker);
    if (row.coin_mint) throw new CoinError('This agent already has a coin.', 409);
    if (row.status !== 'live') throw new CoinError('Only a live agent can launch a coin.', 409);
    const name = String(body?.name ?? '').trim();
    const symbol = String(body?.symbol ?? '').trim().toUpperCase();
    const description = String(body?.description ?? '').trim();
    if (name.length < 2 || [...name].length > 32) throw new CoinError('The coin name needs 2 to 32 characters.');
    if (!/^[A-Z0-9]{2,10}$/.test(symbol)) throw new CoinError('The ticker needs 2 to 10 letters or digits.');
    if (description.length > 400) throw new CoinError('Keep the description under 400 characters.');
    kvSet(this.e.db, `coinmeta:${row.id}`, JSON.stringify({ name, symbol, description }));
    return { uri: `${this.e.cfg.siteUrl}/coin-meta/${row.slug}.json`, name, symbol };
  }

  private async fetchTx(sig: string): Promise<any> {
    if (!SIG_RE.test(sig) || /^1+$/.test(sig)) throw new CoinError('That is not a transaction signature.');
    for (let i = 0; i < 40; i++) {
      const tx = await this.e.rpc.call('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
      if (tx) {
        if (tx.meta?.err) throw new CoinError('That transaction failed on chain.');
        return tx;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new CoinError('The transaction was not found yet. Try again in a minute.', 404);
  }

  private signer(tx: any): string {
    const k = tx?.transaction?.message?.accountKeys?.[0];
    return typeof k === 'string' ? k : k?.signer ? k.pubkey : '';
  }

  async confirmLaunch(slug: string, maker: string, sig: string, mint: string) {
    const row = this.owned(this.e.agents.row(slug), maker);
    if (row.coin_mint) throw new CoinError('This agent already has a coin.', 409);
    if (!ADDR_RE.test(mint)) throw new CoinError('That is not a mint address.');
    const meta = kvGet(this.e.db, `coinmeta:${row.id}`);
    if (!meta) throw new CoinError('Prepare the coin first.');
    const tx = await this.fetchTx(sig);
    if (this.signer(tx) !== maker) throw new CoinError('The launch was not signed by the maker.');
    const create = (tx.transaction.message.instructions ?? []).find((ix: any) => ix.programId === PUMP_PROGRAM.toBase58() && ix.accounts?.[0] === mint && ix.accounts?.[5] === maker);
    if (!create) throw new CoinError('That transaction did not create this coin with the maker as creator.');
    const m = JSON.parse(meta) as CoinMeta;
    this.e.db.prepare('UPDATE agents SET coin_mint = ?, coin_symbol = ?, coin_name = ?, coin_launch_sig = ?, coin_launched_at = ?, updated_at = ? WHERE id = ? AND coin_mint IS NULL').run(mint, m.symbol, m.name, sig, Date.now(), Date.now(), row.id);
    audit(this.e.db, maker, 'coin_launch', { agent: row.slug, mint, sig });
    void this.refreshCurve(mint).catch(() => {});
    this.e.stream?.watch(mint);
    return this.e.agent(row.slug);
  }

  setBuyback(slug: string, maker: string, bps: number) {
    const row = this.owned(this.e.agents.row(slug), maker);
    if (!row.coin_mint) throw new CoinError('Launch a coin first.');
    const v = Math.round(Number(bps));
    if (!Number.isFinite(v) || v < 0 || v > BUYBACK_MAX_BPS) throw new CoinError(`The buyback share is 0 to ${BUYBACK_MAX_BPS / 100} percent of earnings.`);
    this.e.db.prepare('UPDATE agents SET buyback_bps = ?, updated_at = ? WHERE id = ?').run(v, Date.now(), row.id);
    audit(this.e.db, maker, 'buyback_rule', { agent: row.slug, from: row.buyback_bps, to: v });
    return this.e.agent(row.slug);
  }

  async buybackTransaction(slug: string, maker: string, amountMicros: number) {
    const row = this.owned(this.e.agents.row(slug), maker);
    if (!row.coin_mint) throw new CoinError('Launch a coin first.');
    const amt = Math.floor(Number(amountMicros));
    if (!(amt >= 100_000)) throw new CoinError('Buy back at least 0.10 USDC at a time.');
    const q = await this.jupiter.quote(this.e.cfg.usdcMint, row.coin_mint, amt).catch((err) => {
      throw new CoinError(`No swap route right now: ${(err as Error).message}`, 502);
    });
    const transaction = await this.jupiter.swapTransaction(q, maker).catch((err) => {
      throw new CoinError(`The swap could not be built: ${(err as Error).message}`, 502);
    });
    return { transaction, inAmount: q.inAmount, outAmount: q.outAmount, minOut: q.otherAmountThreshold };
  }

  async confirmBuy(slug: string, maker: string, sig: string) {
    const row = this.owned(this.e.agents.row(slug), maker);
    if (!row.coin_mint) throw new CoinError('Launch a coin first.');
    if (this.e.db.prepare('SELECT 1 FROM buys WHERE swap_sig = ?').get(sig)) throw new CoinError('That buy is already recorded.', 409);
    const tx = await this.fetchTx(sig);
    if (this.signer(tx) !== maker) throw new CoinError('That swap was not signed by the maker.');
    const usdc = -balanceDelta(tx, maker, this.e.cfg.usdcMint);
    const got = balanceDelta(tx, maker, row.coin_mint);
    if (usdc <= 0n || got <= 0n) throw new CoinError('That transaction did not swap USDC into this coin.');
    this.e.db.prepare('INSERT INTO buys (id, kind, agent_id, mint, swap_sig, usdc_spent, tokens_bought, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(this.e.newId('b'), 'agent', row.id, row.coin_mint, sig, Number(usdc), got.toString(), Date.now());
    return { usdcSpent: Number(usdc), tokensBought: got.toString() };
  }

  async confirmBurn(slug: string, maker: string, sig: string) {
    const row = this.owned(this.e.agents.row(slug), maker);
    if (!row.coin_mint) throw new CoinError('Launch a coin first.');
    if (this.e.db.prepare('SELECT 1 FROM burns WHERE burn_sig = ?').get(sig)) throw new CoinError('That burn is already recorded.', 409);
    const tx = await this.fetchTx(sig);
    const burns = (tx.transaction.message.instructions ?? []).filter((ix: any) => ix.parsed?.type === 'burnChecked' && ix.parsed.info?.mint === row.coin_mint && ix.parsed.info?.authority === maker);
    const amount = burns.reduce((n: bigint, ix: any) => n + BigInt(ix.parsed.info.tokenAmount.amount), 0n);
    if (amount <= 0n) throw new CoinError('That transaction did not burn this coin from the maker’s wallet.');
    // Burned tokens settle the oldest open buys first, so "spent on buybacks" only counts buys that ended in a burn.
    const open = this.e.db.prepare('SELECT id, usdc_spent, tokens_bought FROM buys WHERE agent_id = ? AND burned = 0 ORDER BY created_at').all(row.id) as { id: string; usdc_spent: number; tokens_bought: string }[];
    let left = amount;
    let usdc = 0;
    for (const b of open) {
      if (BigInt(b.tokens_bought) > left) break;
      left -= BigInt(b.tokens_bought);
      usdc += b.usdc_spent;
      this.e.db.prepare('UPDATE buys SET burned = 1 WHERE id = ?').run(b.id);
    }
    this.e.db.prepare('INSERT INTO burns (id, kind, agent_id, mint, burn_sig, usdc_spent, tokens_burned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(this.e.newId('u'), 'agent', row.id, row.coin_mint, sig, usdc, amount.toString(), Date.now());
    audit(this.e.db, maker, 'coin_burn', { agent: row.slug, sig, amount: amount.toString() });
    return { burned: amount.toString(), usdcCounted: usdc };
  }

  async refreshCurve(mint: string) {
    const r = await this.e.rpc.call('getAccountInfo', [bondingCurvePda(new PublicKey(mint)).toBase58(), { encoding: 'base64', commitment: 'confirmed' }]);
    if (!r?.value?.data?.[0]) return;
    const c = decodeCurve(Buffer.from(r.value.data[0], 'base64'));
    const curve = { marketCapLamports: curveMarketCapLamports(c).toString(), progressBps: curveProgressBps(c.realTokenReserves, c.complete), complete: c.complete, at: Date.now() };
    this.e.db.prepare('UPDATE agents SET coin_curve = ? WHERE coin_mint = ?').run(JSON.stringify(curve), mint);
  }

  async refreshCurves() {
    const mints = this.e.db.prepare('SELECT coin_mint FROM agents WHERE coin_mint IS NOT NULL').all() as { coin_mint: string }[];
    for (const m of mints) {
      await this.refreshCurve(m.coin_mint).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
