import { defineConfig } from 'tsdown'

const base = {
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024' as const,
  fixedExtension: false,
  outputOptions: { codeSplitting: false },
  dts: false,
  clean: false,
}

/** Build the delegation tool and its Host-owned model-selection settings entry. */
export default defineConfig([
  { ...base, entry: ['lib/types/index.js'] },
  { ...base, entry: ['lib/types/invariant.js'] },
  { ...base, entry: ['lib/types/model-selection-settings.js'] },
])
