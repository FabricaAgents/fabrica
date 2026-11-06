// Headless end to end, against the production build in test mode (pretend chain, recorded model replies).
// A stand-in Phantom signs with a real keypair held by this script. Run after `npm run build`: npm run test:e2e
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { Browser, chromeAvailable, type Page } from './cdp';
import { FAKE_PHANTOM, walletFor } from './rig';

const PORT = 3731;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabrica-e2e-'));
const ops = Keypair.generate().publicKey.toBase58();
const burn = Keypair.generate().publicKey.toBase58();
const usdc = Keypair.generate().publicKey.toBase58();
const user = Keypair.generate();
const buyer = Keypair.generate();
const remixer = Keypair.generate();

const results: { name: string; ok: boolean; detail?: string }[] = [];
async function step(name: string, fn: () => Promise<void>) {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message });
    console.log(`FAIL ${name}: ${(e as Error).message}`);
  }
}
const assert = (c: unknown, msg: string) => {
  if (!c) throw new Error(msg);
};

if (!chromeAvailable()) {
  console.log('Chrome is not installed here; skipping the browser run.');
  process.exit(0);
}

const server = spawn('nice', ['node', '--import', 'tsx', 'server/main.ts'], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    FABRICA_TEST_MODE: '1',
    FABRICA_AI_MODE: 'fake',
    FABRICA_DATA_DIR: dataDir,
    FABRICA_SITE_URL: BASE,
    FABRICA_OPS_WALLET: ops,
    FABRICA_BURN_WALLET: burn,
    FABRICA_USDC_MINT: usdc,
    FABRICA_X_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout!.on('data', (c) => (serverLog += c));
server.stderr!.on('data', (c) => (serverLog += c));
const cleanup = () => {
  server.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
};
process.on('exit', cleanup);

for (let i = 0; i < 120; i++) {
  try {
    const h = await (await fetch(`${BASE}/api/health`)).json();
    if (h.examples === 'built') break;
  } catch {
    /* starting */
  }
  await new Promise((r) => setTimeout(r, 500));
}

const walletBinding = walletFor(user);

const browser = new Browser();
await browser.start();
const PAGES = ['/', '/agents', '/agents/mint-inspector', '/agents/release-notes-writer', '/remix/release-notes-writer', '/build', '/docs', '/roadmap', '/token', '/terms'];
let liveSlug = '';
let remixSlug = '';

await step('every page renders on desktop and phone without errors or sideways scroll', async () => {
  for (const phone of [false, true]) {
    for (const p of PAGES) {
      const page = await browser.page(BASE + p, { phone });
      await page.waitFor('document.readyState === "complete" && !!document.querySelector("footer")', 20000, `${p} loaded`);
      await new Promise((r) => setTimeout(r, 400));
      const m = await page.eval('({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })');
      assert(m.sw <= m.cw + 1, `${p} ${phone ? 'phone' : 'desktop'} scrolls sideways (${m.sw} > ${m.cw})`);
      assert(!page.errors.length, `${p}: ${page.errors.join(' | ')}`);
      await page.close();
    }
  }
});

await step('the copy keeps the house rules on every page', async () => {
  for (const p of PAGES) {
    const html = await (await fetch(BASE + p)).text();
    const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
    assert(!html.includes('—'), `${p} has an em dash`);
    assert(!/\bdemo\b/i.test(text), `${p} says demo`);
    assert(!/memecoin/i.test(text), `${p} says memecoin`);
    assert(!/github\.com/i.test(html), `${p} links GitHub`);
    assert(!/aria-label="Fabrica on X"/.test(html), `${p} shows the X icon with no X link set`);
    assert(html.includes('Nothing here is advice.'), `${p} lacks the risk line`);
  }
});

await step('hostile paths and files 404, health is honest', async () => {
  for (const p of ['/agents/../../etc/passwd', '/files/zzz/x', '/api/receipts/nope', '/coin-meta/nope.json']) assert((await fetch(BASE + p)).status === 404, p);
  const h = await (await fetch(`${BASE}/api/health`)).json();
  assert(h.ok && h.payments === 'open' && h.ai === 'fake', JSON.stringify(h));
});

await step('on a phone without Phantom, connecting opens the page in Phantom', async () => {
  const page = await browser.page(`${BASE}/build?s=${encodeURIComponent('Summarise any pasted text into three short bullet points')}`, { phone: true });
  await page.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.includes("Sign in and build") && !b.disabled)', 20000, 'build button');
  await page.click('Sign in and build');
  await page.waitFor('true', 1500);
  await new Promise((r) => setTimeout(r, 1200));
  const hit = page.navs.find((u) => u.startsWith('https://phantom.app/ul/browse/'));
  assert(hit, `no Phantom deep link; saw ${page.navs.slice(-3).join(', ')}`);
  assert(decodeURIComponent(hit!).includes('/build'), 'the deep link keeps the page path');
  await page.close();
});

await step('build: sign in, pay a round, spec, tests, run, publish', async () => {
  await fetch(`${BASE}/api/__test/fund`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: user.publicKey.toBase58(), micros: 50_000_000 }) });
  const sentence = 'Summarise any pasted text into three short bullet points for busy readers';
  const page = await browser.page(`${BASE}/build?s=${encodeURIComponent(sentence)}`, { onNew: FAKE_PHANTOM(user.publicKey.toBase58()), bindings: walletBinding });
  await page.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.includes("Sign in and build") && !b.disabled)', 20000, 'build button');
  await page.click('Sign in and build');
  await page.waitFor('document.querySelector("#sp-name")?.value', 30000, 'the spec');
  await page.click('Write the tests');
  await page.waitFor('document.querySelectorAll(".tcase").length > 4', 30000, 'the tests');
  await page.click('Run the tests');
  await page.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.startsWith("Publish"))', 60000, 'a passing run');
  await page.click('Publish');
  await page.waitFor('location.pathname.startsWith("/agents/") && !!document.querySelector(".run")', 30000, 'the agent page');
  liveSlug = (await page.eval('location.pathname')).split('/')[2];
  assert(liveSlug, 'no slug');
  assert(!page.errors.length, page.errors.join(' | '));
  await page.close();
});

await step('run it: pay in Phantom, get the answer and a receipt', async () => {
  await fetch(`${BASE}/api/__test/fund`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: buyer.publicKey.toBase58(), micros: 5_000_000 }) });
  const page = await browser.page(`${BASE}/agents/${liveSlug}`, { onNew: FAKE_PHANTOM(buyer.publicKey.toBase58()), bindings: walletFor(buyer) });
  await page.waitFor('!!document.querySelector("#in-request")', 20000, 'the form');
  await new Promise((r) => setTimeout(r, 900));
  await page.eval(`(() => { const t = document.querySelector('#in-request'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Fabrica turns one sentence into a tested agent that strangers can pay per call.'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.click('Pay $');
  await page.waitFor('!!document.querySelector(".receipt")?.textContent.includes("Receipt r_")', 30000, 'the receipt').catch(async (e) => {
    throw new Error(`${e.message}; page says: ${await page.eval('[...document.querySelectorAll(".run .notice, .run__stages")].map(n => n.textContent).join(" | ")')} ${page.errors.join(' | ')}`);
  });
  const ans = await page.eval('document.querySelector(".run__result")?.textContent ?? document.querySelector(".run").textContent');
  assert(/Answer/.test(ans), `no answer shown: ${ans.slice(-300)}`);
  await page.close();
  const a = await (await fetch(`${BASE}/api/agents/${liveSlug}`)).json();
  assert(a.stats.paidCalls === 1, `paid calls ${a.stats.paidCalls}`);
});

await step('the maker launches the agent coin from their wallet', async () => {
  const page = await browser.page(`${BASE}/agents/${liveSlug}`, { onNew: FAKE_PHANTOM(user.publicKey.toBase58()), bindings: walletBinding });
  await page.waitFor('!!document.querySelector(".maker")', 20000, 'the maker panel');
  await page.eval(`(() => { const i = document.querySelector('.maker input[placeholder="TICKER"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'BULLET'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.click('Launch from my wallet');
  await page.waitFor('!!document.querySelector("#coin")', 30000, 'the coin section');
  assert(!page.errors.length, page.errors.join(' | '));
  await page.close();
});

await step('remix: the button, one sentence, before and after, tests from scratch, publish, Remixed from', async () => {
  await fetch(`${BASE}/api/__test/fund`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: remixer.publicKey.toBase58(), micros: 50_000_000 }) });
  const page = await browser.page(`${BASE}/agents/${liveSlug}`, { onNew: FAKE_PHANTOM(remixer.publicKey.toBase58()), bindings: walletFor(remixer) });
  // The browser still holds the first maker's sign-in; this is someone else.
  await page.waitFor('document.readyState === "complete"', 20000, 'the agent page');
  await page.eval(`fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true)`);
  await page.goto(`${BASE}/agents/${liveSlug}`);
  await page.waitFor('!!document.querySelector(".agent-head__remix a")', 20000, 'the Remix button');
  await page.eval('document.querySelector(".agent-head__remix a").click()');
  await page.waitFor('location.pathname.startsWith("/remix/") && [...document.querySelectorAll("button")].some(b => b.textContent.includes("and remix"))', 20000, 'the remix page');
  await page.waitFor('!!document.querySelector(".remix-orig")', 20000, 'the original');
  await page.eval(`(() => { const t = document.querySelector('#sentence'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Also return a one line headline for busy readers'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.includes("Sign in and remix") && !b.disabled)', 10000, 'the remix button enabled');
  await page.click('Sign in and remix');
  await page.waitFor('document.querySelectorAll(".rdiff__row").length >= 2 && !!document.querySelector("#sp-name")?.value', 30000, 'the before and after');
  const diff = await page.eval('document.querySelector("#before-after").textContent');
  assert(/Before/.test(diff) && /After/.test(diff) && /Output/.test(diff), `before and after: ${diff.slice(0, 200)}`);
  await page.click('Write the tests');
  await page.waitFor('document.querySelectorAll(".tcase").length > 4', 30000, 'the tests');
  await page.click('Run the tests');
  await page.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.startsWith("Publish"))', 60000, 'a passing run');
  await page.click('Publish');
  await page.waitFor('location.pathname.startsWith("/agents/") && !!document.querySelector(".agent-head__lineage")', 30000, 'the remix page');
  remixSlug = (await page.eval('location.pathname')).split('/')[2];
  const lineage = await page.eval('document.querySelector(".agent-head__lineage").textContent');
  assert(lineage.includes('Remixed from'), lineage);
  assert(await page.eval('!!document.querySelector(".c-royalty")'), 'the royalty in the split');
  assert(!page.errors.length, page.errors.join(' | '));
  await page.close();
  const orig = await browser.page(`${BASE}/agents/${liveSlug}`);
  await orig.waitFor('!!document.querySelector("#remixes .acard")', 20000, 'the remixes list on the original');
  await orig.close();
});

await step('a paid call to the remix splits four ways, the royalty to the original maker', async () => {
  const bal = async (k: Keypair) => BigInt((await (await fetch(`${BASE}/api/__test/balance?wallet=${k.publicKey.toBase58()}`)).json()).balance);
  const before = { orig: await bal(user), remixer: await bal(remixer) };
  const a = await (await fetch(`${BASE}/api/agents/${remixSlug}`)).json();
  assert(a.price.royalty > 0 && a.remixOf.slug === liveSlug, JSON.stringify(a.price));
  const page = await browser.page(`${BASE}/agents/${remixSlug}`, { onNew: FAKE_PHANTOM(buyer.publicKey.toBase58()), bindings: walletFor(buyer) });
  await page.waitFor('!!document.querySelector("#in-request")', 20000, 'the form');
  await new Promise((r) => setTimeout(r, 900));
  await page.eval(`(() => { const t = document.querySelector('#in-request'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'Remixes pay the original maker a royalty in the same payment.'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.click('Pay $');
  await page.waitFor('!!document.querySelector(".receipt")?.textContent.includes("royalty")', 30000, 'a receipt with the royalty');
  await page.close();
  assert((await bal(user)) - before.orig === BigInt(a.price.royalty), 'the original maker got the royalty');
  assert((await bal(remixer)) - before.remixer === BigInt(a.price.maker), 'the remix maker got the rest of the maker part');
});

await browser.stop();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} end-to-end checks passed`);
if (failed.length) console.log(serverLog.split('\n').slice(-20).join('\n'));
cleanup();
process.exit(failed.length ? 1 : 0);
