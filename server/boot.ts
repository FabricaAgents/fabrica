// Starts the API and the Next.js site on one port, in one process.
import http from 'node:http';
import next from 'next';
import type { Engine } from './engine';
import { createHandler } from './http/handler';

declare global {
  // The pages read the engine through this one global, in-process, never over HTTP.
  // eslint-disable-next-line no-var
  var __fabrica: Engine | undefined;
}

export async function serve(engine: Engine, opts: { port: number; dev: boolean; log: (m: string) => void }) {
  const site = next({ dev: opts.dev, dir: process.cwd() });
  await site.prepare();
  globalThis.__fabrica = engine;
  const api = createHandler(engine);
  const nextHandler = site.getRequestHandler();
  const server = http.createServer((req, res) => {
    api(req, res)
      .then((done) => {
        if (!done) return nextHandler(req, res);
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  // A paid call can take a while: the payment confirms, then the agent works.
  server.requestTimeout = 180_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  await new Promise<void>((r) => server.listen(opts.port, '0.0.0.0', r));
  await engine.start();
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    opts.log('shutting down: finishing calls in flight');
    server.close();
    void engine.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 12_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}
