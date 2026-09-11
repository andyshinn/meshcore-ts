import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  target: 'es2022',
  clean: true,
  sourcemap: true,
  // package.json sets "type": "module", so let the extensions follow it
  // (.js for ESM, .cjs for CJS) instead of tsdown's fixed .mjs/.cjs.
  fixedExtension: false,
  // Single-entry library: no content hashes to churn between releases.
  hash: false,
});
