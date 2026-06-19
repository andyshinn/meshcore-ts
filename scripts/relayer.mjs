// Mechanical layer-relocation helper. Usage: node scripts/relayer.mjs <moves.json>
// moves.json maps current project-root-relative paths to their new paths
// (e.g. "src/buffer.ts" -> "src/protocol/buffer.ts"). Both sides are resolved
// against the current working directory so a move's target never depends on the
// source file's directory (ts-morph's SourceFile.move() otherwise resolves a
// relative target relative to the source file, which double-prefixes paths).
// ts-morph rewrites the moved files' own imports AND every referencing import
// across all files in the tsconfig project (src + tests), preserving style.
import { resolve } from 'node:path';
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
  project.getSourceFileOrThrow(resolve(from)).move(resolve(to));
}
project.saveSync();
console.log(`Relayered ${Object.keys(moves).length} files; references updated.`);
