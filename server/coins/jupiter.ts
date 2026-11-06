// Swap routes for buybacks. The swap transaction is built by the router for the wallet that will sign it;
// Fabrica only passes it along and checks the result on chain afterwards.
export interface SwapQuote {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  raw: unknown;
}

export class Jupiter {
  constructor(
    private base: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async quote(inputMint: string, outputMint: string, amount: bigint | number, slippageBps = 150): Promise<SwapQuote> {
    const u = `${this.base}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&swapMode=ExactIn`;
    const res = await this.fetchImpl(u, { signal: AbortSignal.timeout(10_000) });
    const j: any = await res.json().catch(() => null);
    if (!res.ok || !j || j.error) throw new Error(j?.error ? String(j.error) : `the swap router answered ${res.status}`);
    return { inAmount: String(j.inAmount), outAmount: String(j.outAmount), otherAmountThreshold: String(j.otherAmountThreshold), priceImpactPct: String(j.priceImpactPct ?? '0'), raw: j };
  }

  async swapTransaction(q: SwapQuote, user: string): Promise<string> {
    const res = await this.fetchImpl(`${this.base}/swap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoteResponse: q.raw, userPublicKey: user, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }),
      signal: AbortSignal.timeout(15_000),
    });
    const j: any = await res.json().catch(() => null);
    if (!res.ok || !j?.swapTransaction) throw new Error(j?.error ? String(j.error) : `the swap router answered ${res.status}`);
    return String(j.swapTransaction);
  }
}

/** Token balance change for one owner and mint in a jsonParsed transaction, in raw units. */
export function balanceDelta(parsed: any, owner: string, mint: string): bigint {
  const sum = (list: any[]) => (list ?? []).filter((b: any) => b.owner === owner && b.mint === mint).reduce((n: bigint, b: any) => n + BigInt(b.uiTokenAmount?.amount ?? '0'), 0n);
  return sum(parsed?.meta?.postTokenBalances) - sum(parsed?.meta?.preTokenBalances);
}
