'use client';
// Pays a 402 with one transaction signed and sent by Phantom, then calls again with the signature.
import { PublicKey } from '@solana/web3.js';
import { buildPayment, paymentHeader } from '../shared/pay';
import type { PaymentRequirements } from '../shared/types';
import { api } from './api';
import { getProvider, isUserRejection } from './phantom';

export class PayError extends Error {}

export async function payRequirements(req: PaymentRequirements, payer: string): Promise<string> {
  const p = getProvider();
  if (!p) throw new PayError('Phantom is not available in this browser.');
  const { body } = await api<{ blockhash: string }>('/api/chain/blockhash');
  const tx = buildPayment(req, new PublicKey(payer), body.blockhash);
  try {
    const { signature } = await p.signAndSendTransaction(tx);
    return paymentHeader(req, { signature });
  } catch (e) {
    if (isUserRejection(e)) throw new PayError('You declined the payment. Nothing was charged.');
    const msg = String((e as Error)?.message ?? e);
    if (/insufficient|0x1\b/i.test(msg)) throw new PayError('This wallet does not hold enough USDC for the payment, or SOL for the network fee.');
    throw new PayError(`Phantom could not send the payment: ${msg.slice(0, 140)}`);
  }
}
