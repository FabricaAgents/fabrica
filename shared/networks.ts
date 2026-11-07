// Agent networks, the parts both sides need: the limits, the shape of a hire list, the paid plan and the receipt
// tree. docs/NETWORKS.md explains every rule here.

export const NETWORK_LIMITS = {
  /** Agents on one hire list. */
  hiresPerAgent: 3,
  /** Calls to one hired agent in one run. */
  callsPerHire: 2,
  /** Hired calls in one run, every level together. */
  callsPerRun: 6,
  /** Levels: the agent called, the agents it hires, the agents they hire. */
  depth: 3,
  /** Recipients in one payment. One transaction holds 1232 bytes; 8 recipients that all need an account take 1142. */
  recipients: 8,
  /** The maker's hire budget per run, in micro-USDC. */
  budgetMin: 1_000,
  budgetMax: 5_000_000,
  /** A hired call that ran and failed may be called once more on the same slot. */
  retriesPerSlot: 1,
  /** How long a hire waits for a free run slot before it gives up (and costs nothing). */
  waitMs: 10_000,
};

export interface HireEntry {
  slug: string;
  /** How many times one run may call it, 1 or 2. */
  calls: number;
}

export interface HireAgentConfig {
  agents: HireEntry[];
  /** The most the hires of one run may cost, in micro-USDC. */
  budget: number;
}

export interface SlotPrice {
  total: number;
  maker: number;
  royalty: number;
  ai: number;
  platform: number;
}

/** One paid call a run may make to a hired agent. Fixed when the call is quoted. */
export interface HireSlot {
  slot: number;
  /** The slot of the agent that may make this call; 0 for the agent the caller called. */
  parent: number;
  /** 2 for an agent the top agent hires, 3 for one that agent hires. */
  depth: number;
  agentId: string;
  slug: string;
  name: string;
  version: number;
  maker: string;
  royaltyTo: string | null;
  /** One call of this agent: its own parts, not counting its own hires. */
  price: SlotPrice;
  /** What the slots below this one cost. */
  hires: number;
}

/** A hire on the list that is not in the plan, so nobody pays for it. */
export interface SkippedHire {
  parent: number;
  slug: string;
  reason: string;
}

export interface HirePlan {
  slots: HireSlot[];
  skipped: SkippedHire[];
  /** All slots together: the hire part of the quote. */
  total: number;
  /** The top agent's hire budget. */
  budget: number;
}

/** One agent on a hire list, as the agent page and the API show it. */
export interface HirePublic {
  slug: string;
  name: string;
  calls: number;
  status: 'live' | 'paused' | 'missing' | 'example';
  /** What one call to it costs today, its own hires included. 0 when it is not live. */
  perCall: number;
  maker: string | null;
  hires: number;
}

export interface NetworkPublic {
  budget: number;
  hires: HirePublic[];
  /** Paid slots in a run, all levels together, and what they cost today. */
  slots: number;
  hiresTotal: number;
  /** Why a call can not be quoted right now, or null. */
  problem: string | null;
  /** Of the slots paid by callers so far, how many ran at least once. */
  used: { paid: number; ran: number };
}

/** One node of a receipt tree: a paid slot and the calls that ran on it. */
export interface TreeCall {
  id: string;
  status: 'ok' | 'failed';
  attempt: number;
  ms: number;
  createdAt: number;
}

export interface TreeNode {
  slot: number;
  parent: number;
  depth: number;
  agent: { slug: string; name: string };
  version: number;
  paid: SlotPrice & { hires: number; makerTo: string; royaltyTo: string | null };
  calls: TreeCall[];
}

export const sumSlot = (p: SlotPrice) => p.maker + p.royalty + p.ai + p.platform;

/** The slots directly under one slot (0 for the top agent). */
export const childrenOf = (plan: Pick<HirePlan, 'slots'>, parent: number) => plan.slots.filter((s) => s.parent === parent);
