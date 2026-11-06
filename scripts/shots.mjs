// Headless screenshots at real screen sizes, one Chrome at a time, never a window on screen.
// Usage: node scripts/shots.mjs <base> <outdir> <spec...>
// A spec is path[@scroll][:d|:m], scroll = top | mid | bottom | full | <px> | #id. :d desktop 1440x900, :m phone 390x844.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [base, outDir, ...specs] = process.argv.slice(2);
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fabrica-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', (c) => {
    buf += c;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolve(m[1]);
  });
  setTimeout(() => reject(new Error('no debug port')), 20000);
});

const browser = new WebSocket(wsUrl);
await new Promise((r) => (browser.onopen = r));
let id = 0;
const pending = new Map();
const listeners = new Set();
browser.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else for (const l of listeners) l(m);
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    browser.send(JSON.stringify({ id: i, method, params, sessionId }));
  });

const VIEW = {
  d: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  m: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
};
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(outDir, { recursive: true });
const problems = [];
for (const raw of specs) {
  const [specPart, only] = raw.split(':');
  const [pagePath, scrollRaw = 'top', theme] = specPart.split('@');
  for (const vk of only ? [only] : ['d', 'm']) {
    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Emulation.setDeviceMetricsOverride', VIEW[vk], sessionId);
    if (vk === 'm') {
      await send('Emulation.setUserAgentOverride', { userAgent: PHONE_UA }, sessionId);
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
    }
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Log.enable', {}, sessionId);
    const onMsg = (m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') problems.push(`${pagePath} ${vk}: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.text)) problems.push(`${pagePath} ${vk}: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
    };
    listeners.add(onMsg);
    if (theme) await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('fabrica-theme','${theme}')}catch(e){}` }, sessionId);
    await send('Page.navigate', { url: base + pagePath }, sessionId);
    await sleep(Number(process.env.SHOT_WAIT ?? 2500));
    // Reveal everything the screenshot will include, as a reader scrolling there would.
    await send('Runtime.evaluate', { expression: `document.querySelectorAll('.reveal').forEach(e=>e.classList.add('is-in'))` }, sessionId);
    const expr =
      scrollRaw === 'top' || scrollRaw === 'full' ? '0' : scrollRaw === 'mid' ? 'document.documentElement.scrollHeight/2 - innerHeight/2' : scrollRaw === 'bottom' ? 'document.documentElement.scrollHeight' : scrollRaw.startsWith('#') ? `document.querySelector('${scrollRaw}').getBoundingClientRect().top + scrollY - 80` : scrollRaw;
    await send('Runtime.evaluate', { expression: `document.documentElement.style.scrollBehavior='auto';window.scrollTo(0, ${expr})` }, sessionId);
    await sleep(Number(process.env.SHOT_SETTLE ?? 1200));
    const metrics = await send('Runtime.evaluate', { expression: `JSON.stringify({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,h:document.documentElement.scrollHeight})`, returnByValue: true }, sessionId);
    const mm = JSON.parse(metrics.result.result.value);
    if (mm.sw > mm.cw + 1) problems.push(`${pagePath} ${vk}: horizontal overflow ${mm.sw} > ${mm.cw}`);
    let shot;
    if (scrollRaw === 'full') {
      // Capture beyond the viewport without resizing it, so 100vh layouts keep their real size.
      shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: VIEW[vk].width, height: Math.min(mm.h, 16000), scale: 1 } }, sessionId);
    } else shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const slug = pagePath === '/' ? 'home' : pagePath.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    const name = `${slug}${scrollRaw !== 'top' ? `-${scrollRaw.replace(/[^a-z0-9]/gi, '')}` : ''}${theme ? `-${theme}` : ''}-${vk === 'd' ? 'desktop' : 'phone'}.png`;
    fs.writeFileSync(path.join(outDir, name), Buffer.from(shot.result.data, 'base64'));
    listeners.delete(onMsg);
    await send('Target.closeTarget', { targetId });
    console.log(name, `h=${mm.h}`);
  }
}
if (problems.length) console.log('PROBLEMS:\n' + problems.join('\n'));
browser.close();
chrome.kill();
await sleep(300);
fs.rmSync(profile, { recursive: true, force: true });
process.exit(0);
