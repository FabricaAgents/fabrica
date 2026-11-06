// The stand-in Phantom used by the browser runs: it signs with a real keypair held by the test process.
import nacl from 'tweetnacl';
import type { Keypair } from '@solana/web3.js';
import type { Page } from './cdp';

export const FAKE_PHANTOM = (pubkey: string) => `(() => {
  const pending = new Map(); let seq = 0;
  window.__fabResolve = (id, val, err) => { const p = pending.get(id); pending.delete(id); err ? p.reject(new Error(err)) : p.resolve(val); };
  const ask = (kind, payload) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); window.__fabWallet(JSON.stringify({ id, kind, payload })); });
  const b64 = (u8) => { let s = ''; for (const c of u8) s += String.fromCharCode(c); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const publicKey = { toBase58: () => '${pubkey}', toString: () => '${pubkey}' };
  window.phantom = { solana: { isPhantom: true, publicKey,
    connect: async () => ({ publicKey }),
    signMessage: async (msg) => ({ signature: unb64(await ask('sign', b64(msg))) }),
    signAndSendTransaction: async (tx) => {
      const sig = unb64(await ask('sign', b64(tx.serializeMessage())));
      tx.addSignature(tx.feePayer, sig);
      const r = await fetch('/api/__test/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: b64(tx.serialize()) }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || 'send failed');
      return { signature: j.signature };
    } } };
})();`;

export const walletFor = (kp: Keypair) => ({
  __fabWallet: async (payload: string, page: Page) => {
    const { id, kind, payload: data } = JSON.parse(payload);
    if (kind === 'sign') {
      const sig = nacl.sign.detached(Buffer.from(data, 'base64'), kp.secretKey);
      await page.eval(`window.__fabResolve(${id}, ${JSON.stringify(Buffer.from(sig).toString('base64'))})`);
    }
  },
});
