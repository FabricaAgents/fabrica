'use client';
// Phantom without a wallet SDK. On a phone with no injected wallet, the page reopens inside Phantom's own
// browser at the same address, where the wallet exists. Read at the moment of the tap, never during render.
import type { Transaction, VersionedTransaction } from '@solana/web3.js';

export interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: { toBase58(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBase58(): string } }>;
  disconnect?(): Promise<void>;
  signMessage(message: Uint8Array, display?: string): Promise<{ signature: Uint8Array }>;
  signAndSendTransaction(tx: Transaction | VersionedTransaction, opts?: { skipPreflight?: boolean }): Promise<{ signature: string }>;
  on?(event: string, fn: (...args: unknown[]) => void): void;
}

export function getProvider(): PhantomProvider | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider };
  if (w.phantom?.solana?.isPhantom) return w.phantom.solana;
  if (w.solana?.isPhantom) return w.solana;
  return null;
}

/** A coarse pointer and a phone user agent: a touchscreen laptop is not a phone. */
export function isPhone(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarse && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function phantomBrowseLink(href: string): string {
  const u = new URL(href);
  return `https://phantom.app/ul/browse/${encodeURIComponent(u.href)}?ref=${encodeURIComponent(u.origin)}`;
}

export type ConnectResult = { kind: 'connected'; wallet: string } | { kind: 'redirected' } | { kind: 'rejected' };

export async function connectPhantom(): Promise<ConnectResult> {
  const provider = getProvider();
  if (!provider) {
    if (isPhone()) window.location.href = phantomBrowseLink(window.location.href);
    else window.open('https://phantom.com/download', '_blank', 'noopener');
    return { kind: 'redirected' };
  }
  try {
    const res = await provider.connect();
    return { kind: 'connected', wallet: res.publicKey.toBase58() };
  } catch {
    return { kind: 'rejected' };
  }
}

export const isUserRejection = (e: unknown) => {
  const err = e as { code?: number; message?: string };
  return err?.code === 4001 || /reject|declin|denied|cancel/i.test(err?.message ?? '');
};
