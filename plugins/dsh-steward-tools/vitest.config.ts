import { resolve } from 'node:path'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../../vitest.shared.ts'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: [resolve(import.meta.dirname, '../../tsconfig.base.json')] })],
  test: { include: ['tests/**/*.spec.ts'], testTimeout: 15000 },
})
