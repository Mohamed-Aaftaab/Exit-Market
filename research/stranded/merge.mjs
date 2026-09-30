// Step 7b. Concatenate row files built for disjoint block ranges (e.g. pre-365d + last-365d) into one.
// usage: node merge.mjs <out rows json> <rows json...>
import { readJson, writeJson, say } from './lib.mjs';

const [outF, ...inputs] = process.argv.slice(2);
if (inputs.length === 0) throw new Error('usage: node merge.mjs <out rows json> <rows json...>');

const parts = inputs.map((f) => readJson(f));
const rows = parts.flatMap((p) => p.rows).sort((a, b) => a.block - b.block);
const msgRows = parts.flatMap((p) => p.msgRows).sort((a, b) => a.block - b.block);
const positions = new Set(msgRows.map((m) => m.position));
if (positions.size !== msgRows.length) throw new Error('overlapping inputs: duplicate L2->L1 positions');
say('rows', rows.length, 'msgRows', msgRows.length);
writeJson(outF, { rows, msgRows });
