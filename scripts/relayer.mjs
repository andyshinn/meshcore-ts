// Mechanical layer-relocation helper. Usage: node scripts/relayer.mjs <moves.json>
// moves.json maps current src-relative paths to their new paths. ts-morph
// rewrites the moved files' own imports AND every referencing import across
// all files in the tsconfig project (src + tests), preserving specifier style.
import { Project } from 'ts-morph';
import { readFileSync } from 'node:fs';

const mapPath = process.argv[2];
if (!mapPath) {
  console.error('usage: node scripts/relayer.mjs <moves.json>');
  process.exit(1);
}
const moves = JSON.parse(readFileSync(mapPath, 'utf8'));

const project = new Project({ tsConfigFilePath: 'tsconfig.json' });

for (const [from, to] of Object.entries(moves)) {
  project.getSourceFileOrThrow(from).move(to);
}
project.saveSync();
console.log(`Relayered ${Object.keys(moves).length} files; references updated.`);
