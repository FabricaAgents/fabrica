'use client';
// Tools only the agent's maker sees: price, pause, a new version, the coin launch, the buyback rule and burns.
// Every transaction here is built in this browser and signed by the maker's own Phantom.
import { Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { useEffect, useState } from 'react';
import type { CoinInfo, PaymentRequirements } from '../../shared/types';
import { usd } from '../../shared/format';
import { burnCheckedInstruction, createV2Instruction, setComputeLimitInstruction } from '../../shared/pump/instructions';
import { TOKEN_2022_PROGRAM } from '../../shared/pump/constants';
import { api, ApiError } from '../../lib/api';
import { getProvider, isUserRejection } from '../../lib/phantom';
import { payRequirements } from '../../lib/pay';
import { loadSession, signIn, useWallet } from '../../lib/wallet';

async function sendWithPhantom(tx: Transaction | VersionedTransaction): Promise<string> {
  const p = getProvider();
  if (!p) throw new Error('Phantom is not available in this browser.');
  try {
    return (await p.signAndSendTransaction(tx)).signature;
  } catch (e) {
    throw new Error(isUserRejection(e) ? 'You declined in Phantom. Nothing happened.' : `Phantom could not send it: ${String((e as Error).message).slice(0, 140)}`);
  }
}

async function blockhash() {
  return (await api<{ blockhash: string }>('/api/chain/blockhash')).body.blockhash;
}

export function MakerPanel(props: { slug: string; maker: string; status: string; makerFee: number; royalty: { amount: number; to: string } | null; coin: CoinInfo | null; agentName: string }) {
  const w = useWallet();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fee, setFee] = useState((props.makerFee / 1e6).toString());
  const [coin, setCoin] = useState({ name: props.agentName.slice(0, 32), symbol: '', description: '' });
  const [bps, setBps] = useState(props.coin?.buybackBps ?? 1000);
  const [amount, setAmount] = useState('');
  const [pendingBuy, setPendingBuy] = useState<{ amount: string } | null>(null);
  useEffect(() => {
    if (!w.checked) void loadSession();
  }, [w.checked]);
  if (w.session !== props.maker) return null;

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const refresh = () => setTimeout(() => window.location.reload(), 1200);

  const launch = () =>
    act(async () => {
      const prep = await api<{ uri: string; name: string; symbol: string }>(`/api/agents/${props.slug}/coin/prepare`, { body: coin });
      const mint = Keypair.generate();
      const maker = new PublicKey(props.maker);
      const tx = new Transaction({ feePayer: maker, recentBlockhash: await blockhash() });
      tx.add(setComputeLimitInstruction(220_000), createV2Instruction({ mint: mint.publicKey, user: maker, name: prep.body.name, symbol: prep.body.symbol, uri: prep.body.uri }));
      tx.partialSign(mint);
      const sig = await sendWithPhantom(tx);
      await api(`/api/agents/${props.slug}/coin/confirm`, { body: { signature: sig, mint: mint.publicKey.toBase58() } });
      refresh();
      return `$${prep.body.symbol} is live on pump.fun. It may take a minute to show there.`;
    });

  const buyback = () =>
    act(async () => {
      const micros = Math.round(Number(amount) * 1e6);
      const r = await api<{ transaction: string; outAmount: string }>(`/api/agents/${props.slug}/buyback/tx`, { body: { amountMicros: micros } });
      const sig = await sendWithPhantom(VersionedTransaction.deserialize(Buffer.from(r.body.transaction, 'base64')));
      const done = await api<{ tokensBought: string }>(`/api/agents/${props.slug}/buyback/confirm`, { body: { signature: sig } });
      setPendingBuy({ amount: done.body.tokensBought });
      return 'Bought back. Now burn what you bought to complete the buyback.';
    });

  const burn = () =>
    act(async () => {
      if (!props.coin || !pendingBuy) throw new Error('Buy back first.');
      const owner = new PublicKey(props.maker);
      const tx = new Transaction({ feePayer: owner, recentBlockhash: await blockhash() });
      tx.add(setComputeLimitInstruction(60_000), burnCheckedInstruction(owner, new PublicKey(props.coin.mint), BigInt(pendingBuy.amount), 6, TOKEN_2022_PROGRAM));
      const sig = await sendWithPhantom(tx);
      await api(`/api/agents/${props.slug}/burn/confirm`, { body: { signature: sig } });
      setPendingBuy(null);
      refresh();
      return 'Burned. The page shows it once the chain confirms.';
    });

  const newVersion = () =>
    act(async () => {
      const q = await api<{ accepts: PaymentRequirements[]; draftId?: string }>('/api/build', { body: { fromAgent: props.slug } });
      if (q.status !== 402) throw new Error('Unexpected answer.');
      const header = await payRequirements(q.body.accepts[0], props.maker);
      const r = await fetch('/api/build', { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment': header }, body: JSON.stringify({ fromAgent: props.slug }) });
      const b = await r.json();
      if (!r.ok) throw new Error(b.message ?? 'Could not start the new version.');
      window.location.href = `/build?draft=${b.draftId}`;
      return 'Opening the new version.';
    });

  return (
    <section className="maker panel" id="maker">
      <div className="panel__head">
        <h2 className="h4">Your agent</h2>
        <span className="badge badge--accent">Only you see this</span>
      </div>
      <div className="panel__body maker__grid">
        <div className="maker__block">
          <span className="label">Your earnings per call (USDC)</span>
          <div className="row">
            <input className="input" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
            <button className="btn btn--sm" disabled={busy} onClick={() => act(async () => (await api(`/api/agents/${props.slug}`, { method: 'PATCH', body: { makerFee: Math.round(Number(fee) * 1e6) } }), refresh(), 'Saved. New quotes use the new price.'))}>
              Save
            </button>
          </div>
          {props.royalty ? <span className="hint">Of this, {usd(props.royalty.amount)} goes to the maker of {props.royalty.to} as a royalty, inside each payment.</span> : null}
          <div className="row">
            <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => act(async () => (await api(`/api/agents/${props.slug}/${props.status === 'paused' ? 'resume' : 'pause'}`, { body: {} }), refresh(), props.status === 'paused' ? 'Resumed.' : 'Paused. No new quotes until you resume.'))}>
              {props.status === 'paused' ? 'Resume calls' : 'Pause calls'}
            </button>
            <button className="btn btn--ghost btn--sm" disabled={busy} onClick={newVersion}>
              Build a new version
            </button>
          </div>
        </div>
        {props.coin ? (
          <div className="maker__block">
            <span className="label">Buyback rule: share of your earnings</span>
            <div className="row">
              <input className="range" type="range" min={0} max={5000} step={100} value={bps} onChange={(e) => setBps(Number(e.target.value))} />
              <b className="mono">{bps / 100}%</b>
              <button className="btn btn--sm" disabled={busy} onClick={() => act(async () => (await api(`/api/agents/${props.slug}/buyback`, { body: { bps } }), refresh(), 'Rule saved. It applies to calls from now on.'))}>
                Save rule
              </button>
            </div>
            <span className="hint">Set aside so far: {usd(Math.max(0, props.coin.setAsideMicros - props.coin.spentMicros))} still to buy back.</span>
            <div className="row">
              <input className="input" inputMode="decimal" placeholder="USDC to buy back" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <button className="btn btn--sm" disabled={busy || !Number(amount)} onClick={buyback}>
                Buy back
              </button>
              <button className="btn btn--primary btn--sm" disabled={busy || !pendingBuy} onClick={burn}>
                Burn
              </button>
            </div>
          </div>
        ) : props.status === 'live' ? (
          <div className="maker__block">
            <span className="label">Launch this agent&apos;s coin on pump.fun</span>
            <div className="row">
              <input className="input" placeholder="Coin name" maxLength={32} value={coin.name} onChange={(e) => setCoin({ ...coin, name: e.target.value })} />
              <input className="input input--mono" placeholder="TICKER" maxLength={10} value={coin.symbol} onChange={(e) => setCoin({ ...coin, symbol: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />
            </div>
            <textarea className="textarea" rows={2} maxLength={400} placeholder="One line about the coin" value={coin.description} onChange={(e) => setCoin({ ...coin, description: e.target.value })} />
            <button className="btn btn--primary" disabled={busy || coin.symbol.length < 2} onClick={launch}>
              Launch from my wallet
            </button>
            <span className="hint">You sign and pay the network costs in Phantom. Fabrica never holds the coin or any key.</span>
          </div>
        ) : null}
        {msg ? <div className={`notice ${msg.ok ? 'notice--pass' : 'notice--fail'}`}>{msg.text}</div> : null}
        {!w.session ? (
          <button className="btn" onClick={() => signIn()}>
            Sign in
          </button>
        ) : null}
      </div>
    </section>
  );
}
