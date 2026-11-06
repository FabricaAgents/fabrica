// The recorded example agents, in the order they appear on the site.
import type { Brain } from '../../server/ai/fake';
import { brainFor, type ExampleFixture } from './kit';
import { invoiceReader } from './invoice-reader';
import { mintInspector } from './mint-inspector';
import { pageDigest } from './page-digest';
import { regexSmith } from './regex-smith';
import { releaseNotes } from './release-notes';
import { tableAnalyst } from './table-analyst';

export const EXAMPLES: ExampleFixture[] = [mintInspector, tableAnalyst, regexSmith, invoiceReader, pageDigest, releaseNotes];

export const exampleBrains = (): Brain[] => EXAMPLES.map(brainFor);
