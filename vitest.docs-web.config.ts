/** Built documentation pages are checked separately from source-only unit tests. */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/web/docs-tests/**/*.e2e.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
