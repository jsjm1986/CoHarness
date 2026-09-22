import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../vitest.shared.ts'

// tsconfig paths consume session-format's emitted declarations (its durable
// JSON index signatures need exactOptionalPropertyTypes the gateway sources
// do not satisfy); a declaration file has no runtime, so the same specifiers
// resolve to the emitted JavaScript here instead of the .d.ts the type map
// names.
const emittedTypes = fileURLToPath(new URL('../packages/session/session-format/lib/types', import.meta.url))
// The emitted graph's bare workspace imports resolve nowhere in the
// standalone lane, which has no workspace node_modules; map each to the
// emitted module it needs. dsh-llm narrows to assistant-stream.js, all the
// emitted session-format graph loads from it, and the regex finds keep
// subpath specifiers like dsh-llm/discovery on the tsconfig paths.
const emitted = (path: string) => fileURLToPath(new URL(`../packages/${path}`, import.meta.url))

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: {
    tsconfigPaths: true,
    alias: [
      { find: '@deepseek-ai/dsh-session-format/surface', replacement: `${emittedTypes}/surface.js` },
      { find: '@deepseek-ai/dsh-session-format', replacement: `${emittedTypes}/index.js` },
      { find: /^@deepseek-ai\/dsh-util-values$/, replacement: emitted('util/values/lib/types/index.js') },
      { find: /^@deepseek-ai\/dsh-llm$/, replacement: emitted('llm/llm/lib/types/assistant-stream.js') },
      { find: /^@deepseek-ai\/dsh-brand$/, replacement: emitted('util/brand/lib/types/index.js') },
      { find: /^@deepseek-ai\/dsh-util-crypto$/, replacement: emitted('util/crypto/lib/types/index.js') },
    ],
  },
  test: { include: ['tests/**/*.spec.ts'], testTimeout: 30000 },
})
