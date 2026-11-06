// The one process: engine, API and site on one port.
import { loadConfig } from './config';
import { Engine } from './engine';
import { serve } from './boot';

const cfg = loadConfig();
const log = (msg: string) => console.log(`[fabrica] ${msg}`);
const engine = new Engine({ cfg, log });

serve(engine, { port: cfg.port, dev: cfg.dev, log })
  .then(() => log(`listening on ${cfg.port}; AI ${cfg.aiMode}; payments ${engine.payments.open ? 'open' : 'closed'}; token ${cfg.mint ? 'launched' : 'not launched'}${cfg.testMode ? '; TEST MODE (pretend chain)' : ''}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
