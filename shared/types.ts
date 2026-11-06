// The shapes shared by the server, the pages and the browser. Kept by hand; there is no codegen.

export const TOOL_NAMES = ['web_fetch', 'code_run', 'solana_read', 'file_output'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const CATEGORIES = ['Onchain', 'Data', 'Code', 'Research', 'Writing', 'Ops'] as const;
export type Category = (typeof CATEGORIES)[number];

export type FieldType = 'string' | 'text' | 'number' | 'integer' | 'boolean' | 'string[]' | 'object';

export interface FieldSpec {
  name: string;
  type: FieldType;
  description: string;
  required: boolean;
  enum?: string[];
  maxLength?: number;
}

export interface ToolConfig {
  web_fetch?: { allowDomains: string[] };
  code_run?: { network: boolean; allowDomains: string[]; timeMs: number; memoryMb: number };
  solana_read?: { methods: string[] };
  file_output?: { formats: FileFormat[] };
}

export type FileFormat = 'md' | 'csv' | 'json' | 'txt';

export interface AgentSpec {
  name: string;
  slug: string;
  tagline: string;
  brief: string;
  category: Category;
  systemPrompt: string;
  model: string;
  tools: ToolConfig;
  input: FieldSpec[];
  output: FieldSpec[];
  limits: { maxSteps: number; maxOutputTokens: number; maxInputChars: number };
  /** What the maker earns per call, in micro-USDC. */
  makerFee: number;
  examples: { title: string; input: Record<string, unknown> }[];
}

export type CheckType =
  | 'schema'
  | 'equals'
  | 'contains'
  | 'not_contains'
  | 'regex'
  | 'number'
  | 'no_tool_call'
  | 'tool_called'
  | 'regex_matches'
  | 'file_made'
  | 'no_leak'
  | 'judge';

export interface Check {
  type: CheckType;
  /** A dotted path into the output, for equals, number and contains on one field. */
  path?: string;
  value?: unknown;
  values?: string[];
  tolerance?: number;
  pattern?: string;
  tool?: ToolName;
  /** For no_tool_call: a pattern the tool's arguments must not match. */
  argPattern?: string;
  /** For regex_matches: strings the produced pattern must and must not match. */
  shouldMatch?: string[];
  shouldNotMatch?: string[];
  rubric?: string;
}

export type TestKind = 'task' | 'injection' | 'exfiltration' | 'unsafe_tool' | 'robustness';

export interface TestCase {
  id: string;
  kind: TestKind;
  title: string;
  input: Record<string, unknown>;
  checks: Check[];
  /** Safety tests are added by Fabrica and cannot be switched off. */
  required: boolean;
  enabled: boolean;
  /** Indirect injection: what a tool returns during this test instead of the real thing. */
  trap?: { tool: ToolName; content: string };
}

export interface CheckResult {
  type: CheckType;
  pass: boolean;
  detail: string;
}

export interface ToolCallLog {
  tool: string;
  args: string;
  ok: boolean;
  summary: string;
  blocked?: boolean;
  ms: number;
}

export interface TestResult {
  id: string;
  kind: TestKind;
  title: string;
  input: Record<string, unknown>;
  output: unknown;
  error: string | null;
  checks: CheckResult[];
  tools: ToolCallLog[];
  pass: boolean;
  ms: number;
  aiCostMicros: number;
}

export interface TestRunSummary {
  id: string;
  total: number;
  passed: number;
  safetyTotal: number;
  safetyPassed: number;
  taskTotal: number;
  taskPassed: number;
  /** Task pass rate, 0 to 100. */
  score: number;
  publishable: boolean;
  startedAt: number;
  finishedAt: number | null;
  aiCostMicros: number;
  model: string;
}

export type AgentStatus = 'live' | 'paused' | 'example' | 'retired';

export interface AgentStats {
  paidCalls: number;
  revenueMicros: number;
  makerEarnedMicros: number;
  /** For a remix: royalties its calls paid the original's maker. */
  royaltyPaidMicros: number;
  buyers: number;
  repeatBuyers: number;
  okCalls: number;
  failedCalls: number;
  avgMs: number;
  last24hCalls: number;
}

export interface CoinInfo {
  mint: string;
  symbol: string;
  name: string;
  launchedAt: number;
  launchSig: string;
  buybackBps: number;
  setAsideMicros: number;
  spentMicros: number;
  burnedRaw: string;
  burns: number;
  curve: { marketCapLamports: string; progressBps: number; complete: boolean; at: number } | null;
}

export interface AgentPublic {
  id: string;
  slug: string;
  status: AgentStatus;
  example: boolean;
  maker: string | null;
  /** The sentence the agent was built from. */
  sentence: string | null;
  name: string;
  tagline: string;
  brief: string;
  category: Category;
  model: string;
  tools: ToolName[];
  toolConfig: ToolConfig;
  input: FieldSpec[];
  output: FieldSpec[];
  examples: AgentSpec['examples'];
  price: PriceBreakdown;
  publishedAt: number;
  version: number;
  pauseReason: string | null;
  tests: TestRunSummary | null;
  stats: AgentStats;
  coin: CoinInfo | null;
  /** The agent this one was remixed from, or null for an original. */
  remixOf: RemixParent | null;
  /** Share of the maker part each paid call sends to the original's maker, in basis points. 0 when none. */
  royaltyBps: number;
  /** Live remixes of this agent and the royalties they paid its maker (calls by other wallets only). */
  remixes: { count: number; royaltiesMicros: number };
}

export interface RemixParent {
  slug: string;
  name: string;
  maker: string | null;
  example: boolean;
}

export interface PriceBreakdown {
  /** All amounts in micro-USDC. total = maker + royalty + ai + platform. */
  total: number;
  /** What the agent's own maker receives. */
  maker: number;
  /** For a remix: what the original's maker receives, carved out of the maker part. 0 otherwise. */
  royalty: number;
  ai: number;
  platform: number;
}

export interface Receipt {
  id: string;
  agentSlug: string;
  payer: string;
  txSig: string;
  total: number;
  maker: number;
  /** Paid to the original's maker when the agent is a remix; 0 otherwise. */
  royalty: number;
  royaltyTo: string | null;
  ai: number;
  platform: number;
  status: 'ok' | 'failed' | 'retried';
  inputHash: string;
  outputHash: string | null;
  ms: number;
  aiCostMicros: number;
  createdAt: number;
  serverSig: string;
}

export interface PaymentRecipient {
  role: 'maker' | 'royalty' | 'ai' | 'platform' | 'build';
  address: string;
  amount: string;
  /** The recipient has no USDC account yet; the payer's transaction creates it. */
  createAccount?: boolean;
}

export interface PaymentRequirements {
  scheme: 'split';
  network: 'solana' | 'solana-devnet' | 'solana-localnet';
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  outputSchema?: unknown;
  extra: {
    name: 'USD Coin';
    decimals: 6;
    memo: string;
    nonce: string;
    expiresAt: number;
    recipients: PaymentRecipient[];
    computeUnitPrice: number;
  };
}

export interface HolderTier {
  name: string;
  minTokens: number;
  liveAgents: number;
  buildDiscountBps: number;
  feeDiscountBps: number;
  earlyAccess: boolean;
}

export interface SiteConfig {
  siteUrl: string;
  xUrl: string | null;
  mint: string | null;
  usdcMint: string;
  network: PaymentRequirements['network'];
  buildFee: number;
  buildOpen: boolean;
  buildClosedReason: string | null;
  /** Whether new remixes can be started (REMIX=off closes them; existing remixes keep paying royalties). */
  remixOpen: boolean;
  payOpen: boolean;
  aiMode: 'openrouter' | 'fake' | 'offline';
  testMode: boolean;
  tiers: HolderTier[] | null;
  baseTier: HolderTier;
}
