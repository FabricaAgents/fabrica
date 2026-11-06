// Pages read the engine in-process through the global that server/boot.ts sets. Nothing is fetched over HTTP.
import type { Engine } from '../server/engine';

export function engine(): Engine {
  const e = globalThis.__fabrica;
  if (!e) throw new Error('The Fabrica engine is not running in this process. Start the site with npm run dev or npm start.');
  return e;
}
