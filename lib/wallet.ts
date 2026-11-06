'use client';
// One wallet state for every in-page app: the connected address and the signed-in maker session.
import bs58 from 'bs58';
import { useSyncExternalStore } from 'react';
import { api } from './api';
import { connectPhantom, getProvider, isUserRejection } from './phantom';

export interface WalletState {
  address: string | null;
  session: string | null;
  checked: boolean;
  busy: boolean;
  error: string | null;
}

let state: WalletState = { address: null, session: null, checked: false, busy: false, error: null };
const subs = new Set<() => void>();
const set = (p: Partial<WalletState>) => {
  state = { ...state, ...p };
  subs.forEach((f) => f());
};

export function useWallet(): WalletState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
    () => state,
  );
}

export async function loadSession() {
  try {
    const { body } = await api<{ wallet: string | null }>('/api/me');
    set({ session: body.wallet, address: state.address ?? body.wallet, checked: true });
    const p = getProvider();
    if (p && body.wallet) {
      // Reconnect quietly when the site is already trusted.
      p.connect({ onlyIfTrusted: true }).then((r) => set({ address: r.publicKey.toBase58() }), () => {});
    }
  } catch {
    set({ checked: true });
  }
}

export async function connect(): Promise<string | null> {
  set({ busy: true, error: null });
  const r = await connectPhantom();
  set({ busy: false });
  if (r.kind === 'connected') {
    set({ address: r.wallet });
    return r.wallet;
  }
  if (r.kind === 'rejected') set({ error: 'Phantom declined the connection.' });
  return null;
}

export async function signIn(): Promise<boolean> {
  const wallet = state.address ?? (await connect());
  if (!wallet) return false;
  const p = getProvider();
  if (!p) return false;
  set({ busy: true, error: null });
  try {
    const { body } = await api<{ nonce: string; message: string }>('/api/auth/nonce', { body: { wallet } });
    const { signature } = await p.signMessage(new TextEncoder().encode(body.message), 'utf8');
    await api('/api/auth/verify', { body: { wallet, nonce: body.nonce, message: body.message, signature: bs58.encode(signature) } });
    set({ session: wallet, busy: false });
    return true;
  } catch (e) {
    set({ busy: false, error: isUserRejection(e) ? 'You declined the signature. Nothing happened.' : (e as Error).message });
    return false;
  }
}

export async function signOut() {
  await api('/api/auth/logout', { body: {} }).catch(() => {});
  set({ session: null });
}

/** The wallet to act with right now, read outside React's render cycle. */
export function currentWallet(): string | null {
  return state.session ?? state.address;
}
