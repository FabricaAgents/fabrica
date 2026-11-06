// The real reads the example agents make. scripts/record-tools.ts records exactly these.
export const MINTS = {
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  wsol: 'So11111111111111111111111111111111111111112',
  t22: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
};

const mintReads = (mint: string) => [
  { method: 'getAccountInfo', args: { address: mint } },
  { method: 'getTokenSupply', args: { mint } },
];

export const PAGES = {
  com: 'https://example.com/',
  org: 'https://example.org/',
  net: 'https://example.net/',
  missing: 'https://example.com/missing-page',
  file: 'file:///etc/passwd',
};

export const RECORD_PLAN = {
  chain: [...mintReads(MINTS.usdc), ...mintReads(MINTS.wsol), ...mintReads(MINTS.t22), { method: 'getAccountInfo', args: { address: MINTS.program } }],
  web: Object.values(PAGES),
};
