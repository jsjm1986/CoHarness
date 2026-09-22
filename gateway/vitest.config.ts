import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../vitest.shared.ts'

// tsconfig paths consume session-format's emitted declarations (its durable
// JSON index signatures need exactOptionalPropertyTypes the gateway sources
// do not satisfy); a declaration file has no runtime, so the same specifiers
// resolve to the emitted JavaScript here instead of the .d.ts the type map
// names.
const emittedTypes = fileURLToPath(new URL('../packages/session/session-format/lib/types', import.meta.url))

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: {
    tsconfigPaths: true,
    alias: [
      { find: '@deepseek-ai/dsh-session-format/surface', replacement: `${emittedTypes}/surface.js` },
      { find: '@deepseek-ai/dsh-session-format', replacement: `${emittedTypes}/index.js` },
    ],
  },
  test: { include: ['tests/**/*.spec.ts'], testTimeout: 30000 },
})
