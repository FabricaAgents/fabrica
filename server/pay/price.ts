// What a call costs and where each part goes. The AI part is the most the call can spend on AI, so every call
// pays for its own inference before it runs. A remix's royalty comes out of the maker part, so it never changes
// what the caller pays.
import { aiCeilingMicros, modelById } from '../../shared/models';
import { royaltyOf } from '../../shared/remix';
import type { AgentSpec, HolderTier, PriceBreakdown } from '../../shared/types';

export interface FeeRules {
  platformFeeBps: number;
  platformFeeMinMicros: number;
}

export function priceFor(spec: AgentSpec, rules: FeeRules, makerTier?: HolderTier | null, royaltyBps = 0): PriceBreakdown {
  const model = modelById(spec.model);
  if (!model) throw new Error(`unknown model ${spec.model}`);
  const ai = aiCeilingMicros(model, spec.limits.maxSteps, spec.limits.maxOutputTokens);
  const maker = spec.makerFee;
  const discount = Math.min(Math.max(makerTier?.feeDiscountBps ?? 0, 0), 10_000);
  const fee = Math.ceil((((maker + ai) * rules.platformFeeBps) / 10_000) * (1 - discount / 10_000));
  const platform = Math.max(rules.platformFeeMinMicros, fee);
  const royalty = royaltyOf(maker, royaltyBps);
  return { total: maker + ai + platform, maker: maker - royalty, royalty, ai, platform };
}
