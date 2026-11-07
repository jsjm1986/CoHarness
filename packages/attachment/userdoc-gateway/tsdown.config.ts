/** Bundle every published document entry and its wire validators for standalone consumers. @module */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/protocol.js', 'lib/types/server.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { alwaysBundle: [/^zod(?:\/|$)/] },
})
