// The roadmap: five phases, each about one part of the factory. A phase is live, next or planned; planned phases
// carry no dates. An item in a phase that is not live yet can be marked live or next on its own. Add a phase at the
// end; the page and its count follow.

export type PhaseState = 'live' | 'next' | 'planned';
export interface RoadmapItem {
  name: string;
  text: string;
  state?: PhaseState;
}
export interface RoadmapPhase {
  name: string;
  focus: string;
  line: string;
  state: PhaseState;
  items: RoadmapItem[];
}

export const ROADMAP: RoadmapPhase[] = [
  {
    name: 'The Factory',
    focus: 'Building',
    line: 'One sentence in, a tested agent out, paid per call.',
    state: 'live',
    items: [
      { name: 'One-sentence builds', text: 'Describe an agent and Fabrica writes its spec, its contract and its tools.' },
      { name: 'Attacked before it sells', text: 'Every agent gets its own test suite: real tasks plus hidden instructions, data leaks and unsafe tool use. It goes live only if it passes.' },
      { name: 'A sandbox for every run', text: 'Code runs walled off from the host and from internal networks.' },
      { name: 'Paid per call in USDC', text: 'One transaction the caller signs pays the maker, the AI and the platform at once. Fabrica never holds the money.' },
      { name: 'Signed receipts', text: 'Every paid call gets a receipt nobody can edit afterwards.' },
      { name: 'A tool in every assistant', text: 'Every live agent is a tool over MCP, and any agent can pay for a call over x402.' },
      { name: 'Agent coins and the burn', text: 'Makers launch a coin for their agent with a public buyback meter, and platform fees buy back and burn $FABRICA.' },
    ],
  },
  {
    name: 'Remix and Versions',
    focus: 'Ownership',
    line: 'Make any agent yours, and keep improving it.',
    state: 'next',
    items: [
      { name: 'Remix', text: 'Take any live agent, change one sentence and get your own version, tested from scratch.', state: 'live' },
      { name: 'Royalties built in', text: 'The original maker earns a share of every call to a remix, paid in the same transaction.', state: 'live' },
      { name: 'Versions', text: 'Improve an agent without losing its record. Every version is tested again, with a public changelog and rollback.' },
      { name: 'Signed test reports', text: 'An agent’s test results that anyone can check, so its track record travels with it.' },
    ],
  },
  {
    name: 'Agent Networks',
    focus: 'Working together',
    line: 'Agents that hire each other to finish bigger jobs.',
    state: 'planned',
    items: [
      { name: 'Agents hire agents', text: 'In the middle of a run, an agent calls other Fabrica agents and pays each call itself.' },
      { name: 'Pipelines from one sentence', text: 'A job like read this invoice, check the numbers, write the summary becomes a chain of tested agents.' },
      { name: 'A price before you run', text: 'The full cost of a multi-agent job up front, with a hard spending cap per run.' },
      { name: 'Receipt trees', text: 'See which agent did what, and who was paid for it.' },
    ],
  },
  {
    name: 'Beyond Text',
    focus: 'Senses and timing',
    line: 'Agents that listen, see and act on their own clock.',
    state: 'planned',
    items: [
      { name: 'Voice', text: 'Talk to an agent and it answers out loud.' },
      { name: 'Vision', text: 'Agents that read images, screenshots and PDFs.' },
      { name: 'Schedules and triggers', text: 'Run every morning, when a wallet moves or when a new coin launches.' },
      { name: 'Alerts and webhooks', text: 'Results come to you instead of you asking.' },
      { name: 'Memory, if you want it', text: 'An agent can remember each buyer’s preferences across calls, only when the buyer opts in.' },
    ],
  },
  {
    name: 'Fabrica for Teams',
    focus: 'Scale',
    line: 'The factory for companies that run agents every day.',
    state: 'planned',
    items: [
      { name: 'Private agents', text: 'Agents only you or your team can call.' },
      { name: 'Team keys and limits', text: 'Spending limits per key, with usage you can see.' },
      { name: 'Receipts for accounting', text: 'Every receipt exported in one file.' },
      { name: 'Kits for developers', text: 'TypeScript and Python kits, and one-click install into AI apps.' },
      { name: 'Holder perks', text: 'Lower build fees, priority runs and first access to new models and tools, across every phase.' },
    ],
  },
];
