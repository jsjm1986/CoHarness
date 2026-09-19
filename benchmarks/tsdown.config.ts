import { defineConfig } from 'tsdown'

const shared = {
  format: 'esm' as const,
  platform: 'node' as const,
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//],
    onlyBundle: false as const,
  },
}

/** Compile measured benchmark workers while keeping workspace packages on their built `lib` entries. */
export default defineConfig([
  {
    ...shared,
    entry: { 'terminal-io.worker': 'terminal-io/terminal-io.worker.ts' },
    outDir: '.dsh-build/terminal-io',
    clean: true,
    tsconfig: 'tsconfig.host.json',
  },
])
