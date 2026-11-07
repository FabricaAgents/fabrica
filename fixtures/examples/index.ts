// The recorded example agents, in the order they appear on the site.
import type { Brain } from '../../server/ai/fake';
import { brainFor, type ExampleFixture } from './kit';
import { invoiceReader } from './invoice-reader';
import { invoiceCheck } from './invoice-check';
import { mintInspector } from './mint-inspector';
import { pageDigest } from './page-digest';
import { regexSmith } from './regex-smith';
import { releaseNotes } from './release-notes';
import { tableAnalyst } from './table-analyst';
import { VERSION_RECORDINGS } from '../recorded/versions';

// Invoice Check hires Invoice Reader and Table Analyst, so it is built after them.
export const EXAMPLES: ExampleFixture[] = [mintInspector, tableAnalyst, regexSmith, invoiceReader, pageDigest, releaseNotes, invoiceCheck];

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!]$/, '');

/** The recorded improvement replies: a request for a recorded agent gets the reply the model gave. */
export const recordedVersions: Brain = (v) => {
  if (v.req.purpose !== 'version') return null;
  const r = v.versionRequest();
  const hit = r && VERSION_RECORDINGS.find((x) => x.agent === r.spec?.name && norm(x.request) === norm(r.change));
  return hit ? { text: JSON.stringify(hit.reply) } : null;
};

export const exampleBrains = (): Brain[] => [...EXAMPLES.map(brainFor), recordedVersions];
