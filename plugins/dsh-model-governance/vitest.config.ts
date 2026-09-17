import { resolve } from 'node:path'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../../vitest.shared.ts'

const repo = resolve(import.meta.dirname, '../..')

export default defineConfig({
  root: import.meta.dirname,
  plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: [resolve(repo, 'tsconfig.base.json')] })],
  resolve: {
    alias: {
      '@deepseek-ai/dsh-llm/package.json': resolve(repo, 'packages/llm/llm/package.json'),
    },
  },
  test: { include: ['tests/**/*.spec.ts'] },
})
