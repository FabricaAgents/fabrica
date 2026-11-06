// Runs one piece of untrusted JavaScript inside QuickJS compiled to WebAssembly, then exits.
// The guest gets console.log, a frozen INPUT value and, only when its agent allows the network, fetch_text(url),
// which asks the host thread to fetch through the same guard as the web tool. Nothing else exists in the guest:
// no files, no process, no timers, no host objects. Memory, stack and time are capped by the runtime itself.
import { parentPort, workerData } from 'node:worker_threads';
import { newQuickJSAsyncWASMModule, newQuickJSWASMModule, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

const { code, input, memoryBytes, stackBytes, timeMs, maxOutput, network, maxFetches } = workerData;

let fetchSeq = 0;
const waiting = new Map();
parentPort.on('message', (m) => {
  if (m?.type === 'fetched' && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
  }
});
const askHost = (url) =>
  new Promise((resolve) => {
    const id = ++fetchSeq;
    waiting.set(id, resolve);
    parentPort.postMessage({ type: 'fetch', id, url });
  });

async function main() {
  const mod = network ? await newQuickJSAsyncWASMModule() : await newQuickJSWASMModule();
  const started = Date.now();
  const rt = mod.newRuntime();
  rt.setMemoryLimit(memoryBytes);
  rt.setMaxStackSize(stackBytes);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(started + timeMs));
  const vm = rt.newContext();

  let stdout = '';
  const write = (text) => {
    if (stdout.length < maxOutput) stdout += text.slice(0, maxOutput - stdout.length);
  };
  const logFn = vm.newFunction('log', (...args) => {
    const parts = args.map((h) => {
      try {
        const v = vm.dump(h);
        return typeof v === 'string' ? v : JSON.stringify(v);
      } catch {
        return '[unprintable]';
      }
    });
    write(parts.join(' ') + '\n');
  });
  const consoleObj = vm.newObject();
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) vm.setProp(consoleObj, k, logFn);
  vm.setProp(vm.global, 'console', consoleObj);
  consoleObj.dispose();
  logFn.dispose();

  const inputRes = vm.evalCode(`Object.freeze(JSON.parse(${JSON.stringify(JSON.stringify(input ?? null))}))`);
  if (!inputRes.error) {
    vm.setProp(vm.global, 'INPUT', inputRes.value);
    inputRes.value.dispose();
  } else inputRes.error.dispose();

  let fetches = 0;
  if (network) {
    const fetchFn = vm.newAsyncifiedFunction('fetch_text', async (urlH) => {
      const url = vm.getString(urlH);
      fetches++;
      if (fetches > maxFetches) return { error: vm.newError(`fetch_text: at most ${maxFetches} requests per run`) };
      const r = await askHost(url);
      if (!r.ok) return { error: vm.newError(`fetch_text: ${r.error}`) };
      return vm.newString(r.text);
    });
    vm.setProp(vm.global, 'fetch_text', fetchFn);
    fetchFn.dispose();
  }

  const failure = (h) => {
    const e = vm.dump(h);
    h.dispose();
    if (e && typeof e === 'object') return `${e.name ?? 'Error'}: ${e.message ?? ''}`;
    return String(e);
  };

  let error = null;
  let value;
  const res = network ? await vm.evalCodeAsync(code, 'agent.js') : vm.evalCode(code, 'agent.js');
  if (res.error) error = failure(res.error);
  else {
    try {
      value = vm.dump(res.value);
    } catch {
      value = undefined;
    }
    res.value.dispose();
    const jobs = rt.executePendingJobs(200);
    if (jobs.error) error = failure(jobs.error);
  }
  const ms = Date.now() - started;
  const interrupted = ms >= timeMs;
  let valueText = null;
  if (value !== undefined) {
    try {
      valueText = JSON.stringify(value)?.slice(0, maxOutput) ?? null;
    } catch {
      valueText = String(value).slice(0, maxOutput);
    }
  }
  const out = {
    ok: error === null,
    stdout,
    value: valueText,
    error: error && interrupted && /interrupted/i.test(error) ? 'Stopped: ran past the time limit.' : error && /out of memory/i.test(error) ? 'Stopped: ran past the memory limit.' : error,
    ms,
    fetches,
  };
  try {
    vm.dispose();
    rt.dispose();
  } catch {
    /* the worker exits next either way */
  }
  return out;
}

main()
  .then((out) => parentPort.postMessage({ type: 'done', out }))
  .catch((err) => parentPort.postMessage({ type: 'done', out: { ok: false, stdout: '', value: null, error: `Sandbox error: ${String(err?.message ?? err)}`, ms: 0, fetches: 0 } }));
