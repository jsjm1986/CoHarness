import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../vitest.shared.ts'

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: { tsconfigPaths: true },
  test: { include: ['tests/**/*.spec.ts'], testTimeout: 30000 },
})
