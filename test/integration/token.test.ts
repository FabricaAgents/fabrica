import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, Transaction } from '@solana/web3.js';
import { makeEngine } from '../helpers';
import { burnCheckedInstruction } from '../../shared/pump/instructions';
import { ataAddress } from '../../shared/pump/pda';
import { TOKEN_2022_PROGRAM } from '../../shared/pump/constants';

test('before launch the token shows nothing; after launch tiers and burns come from the chain', async () => {
  const pre = makeEngine();
  assert.equal(await pre.e.token.stats(), null, 'no token numbers before launch');
  assert.equal(pre.e.siteConfig().tiers, null);

  const burnKp = Keypair.generate();
  const mint = Keypair.generate().publicKey.toBase58();
  const tiers = JSON.stringify([{ name: 'Holder', minTokens: 1000, liveAgents: 10, buildDiscountBps: 2000, feeDiscountBps: 2500, earlyAccess: true }]);
  const { e, chain } = makeEngine({ env: { FABRICA_MINT: mint, FABRICA_BURN_WALLET: burnKp.publicKey.toBase58(), FABRICA_TIERS: tiers } });
  chain.mints.set(mint, { decimals: 6, supply: 1_000_000_000_000_000n, program: TOKEN_2022_PROGRAM.toBase58() });
  const holder = Keypair.generate().publicKey.toBase58();
  chain.accounts.set(ataAddress(Keypair.generate().publicKey, Keypair.generate().publicKey).toBase58(), { owner: holder, mint, amount: 5_000_000_000n });
  assert.equal((await e.token.tierFor(holder)).name, 'Holder');
  assert.equal((await e.token.tierFor(Keypair.generate().publicKey.toBase58())).name, 'Maker');

  const acct = ataAddress(burnKp.publicKey, new (await import('@solana/web3.js')).PublicKey(mint)).toBase58();
  chain.accounts.set(acct, { owner: burnKp.publicKey.toBase58(), mint, amount: 7_000_000n });
  const bh = (await e.rpc.call('getLatestBlockhash', [])).value.blockhash;
  const tx = new Transaction({ feePayer: burnKp.publicKey, recentBlockhash: bh }).add(burnCheckedInstruction(burnKp.publicKey, new (await import('@solana/web3.js')).PublicKey(mint), 7_000_000n, 6, TOKEN_2022_PROGRAM));
  tx.sign(burnKp);
  const sig = await e.rpc.call('sendTransaction', [tx.serialize().toString('base64')]);
  assert.deepEqual(await e.token.recordManualBurn(sig), { burned: '7000000' });
  await assert.rejects(e.token.recordManualBurn(sig), /already/);
  const stats = await e.token.stats();
  assert.equal(stats!.burnedRaw, '7000000');
  assert.equal(stats!.supply!.amount, String(1_000_000_000_000_000n - 7_000_000n));
});
