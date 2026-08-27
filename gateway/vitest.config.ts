import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: { include: ['tests/**/*.spec.ts'], testTimeout: 30000 },
})
