// One headless Chrome over its debugging protocol. No window ever opens.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const chromeAvailable = () => fs.existsSync(CHROME);

export interface PageOpts {
  phone?: boolean;
  onNew?: string;
  bindings?: Record<string, (payload: string, page: Page) => void | Promise<void>>;
}

export interface Page {
  eval: (expr: string) => Promise<any>;
  waitFor: (expr: string, timeoutMs?: number, what?: string) => Promise<any>;
  click: (text: string) => Promise<void>;
  navs: string[];
  errors: string[];
  goto: (url: string) => Promise<void>;
  shot: (file: string) => Promise<void>;
  close: () => Promise<void>;
}

export class Browser {
  private ws!: WebSocket;
  private seq = 0;
  private pending = new Map<number, (m: any) => void>();
  private proc!: ChildProcess;
  private profile!: string;
  private listeners = new Set<(m: any) => void>();

  async start() {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fabrica-cdp-'));
    this.proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars', `--user-data-dir=${this.profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const url = await new Promise<string>((resolve, reject) => {
      let buf = '';
      this.proc.stderr!.on('data', (c) => {
        buf += c;
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) resolve(m[1]);
      });
      setTimeout(() => reject(new Error('no debug port')), 20000);
    });
    this.ws = new WebSocket(url);
    await new Promise((r) => (this.ws.onopen = r));
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      } else for (const l of this.listeners) l(m);
    };
  }

  send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async page(url: string, opts: PageOpts = {}): Promise<Page> {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const navs: string[] = [];
    const errors: string[] = [];
    let page!: Page;
    const onEvent = (m: any) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Page.frameRequestedNavigation') navs.push(m.params.url);
      if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) navs.push(m.params.frame.url);
      if (m.method === 'Network.requestWillBeSent') navs.push(m.params.request.url);
      if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon|status of 40[0-9]|status of 50[23]/.test(m.params.entry.text)) errors.push(m.params.entry.text);
      if (m.method === 'Runtime.bindingCalled' && opts.bindings?.[m.params.name]) void opts.bindings[m.params.name](m.params.payload, page);
    };
    this.listeners.add(onEvent);
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Network.enable', {}, sessionId);
    await this.send('Log.enable', {}, sessionId);
    if (opts.phone) {
      await this.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
      await this.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }, sessionId);
      await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
      await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }] }, sessionId);
    } else {
      await this.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    }
    for (const name of Object.keys(opts.bindings ?? {})) await this.send('Runtime.addBinding', { name }, sessionId);
    if (opts.onNew) await this.send('Page.addScriptToEvaluateOnNewDocument', { source: opts.onNew }, sessionId);
    const evalIn = async (expression: string) => {
      const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    page = {
      eval: evalIn,
      navs,
      errors,
      shot: async (file: string) => {
        const r = await this.send('Page.captureScreenshot', { format: 'png' }, sessionId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      },
      goto: async (u: string) => {
        await this.send('Page.navigate', { url: u }, sessionId);
      },
      click: async (text: string) => {
        const ok = await evalIn(`(() => { const el = [...document.querySelectorAll('button,a,summary')].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}) && !e.disabled); if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true; })()`);
        if (!ok) throw new Error(`nothing clickable named "${text}"`);
      },
      waitFor: async (expression: string, timeoutMs = 20000, what = expression) => {
        const start = Date.now();
        for (;;) {
          const v = await evalIn(expression).catch(() => false);
          if (v) return v;
          if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
          await new Promise((r) => setTimeout(r, 150));
        }
      },
      close: async () => {
        this.listeners.delete(onEvent);
        await this.send('Target.closeTarget', { targetId });
      },
    };
    await this.send('Page.navigate', { url }, sessionId);
    return page;
  }

  async stop() {
    this.ws?.close();
    this.proc?.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(this.profile, { recursive: true, force: true });
  }
}
