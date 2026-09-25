import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../vitest.shared.ts'

// tsconfig paths consume the workspace packages' emitted declarations (the
// session-format durable JSON index signatures need exactOptionalPropertyTypes
// the gateway sources do not satisfy); a declaration file has no runtime, so
// the same specifiers resolve to the emitted JavaScript here instead of the
// .d.ts the type map names.
const emitted = (path: string) => fileURLToPath(new URL(`../${path}/lib/types`, import.meta.url))
// The emitted graph's bare workspace imports resolve nowhere in the
// standalone lane, which has no workspace node_modules; map each to the
// emitted module it needs. dsh-llm narrows to assistant-stream.js because the
// emitted session-format chain only loads AssistantStreamAccumulator from it;
// exact-match regexes keep subpath specifiers like dsh-llm/discovery and
// dsh-session-format/surface on their own entries.
const pkg = (path: string, file = 'index.js') => `${emitted(path)}/${file}`

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: {
    tsconfigPaths: true,
    alias: [
      { find: '@deepseek-ai/dsh-session-format-catalog', replacement: pkg('packages/session/session-format-catalog') },
      { find: '@deepseek-ai/dsh-session-format/surface', replacement: pkg('packages/session/session-format', 'surface.js') },
      { find: /^@deepseek-ai\/dsh-session-format$/, replacement: pkg('packages/session/session-format') },
      { find: /^@deepseek-ai\/dsh-session-format-v0-to-v1$/, replacement: pkg('packages/session/session-format-v0-to-v1') },
      { find: /^@deepseek-ai\/dsh-session-format-v1-to-v2$/, replacement: pkg('packages/session/session-format-v1-to-v2') },
      { find: /^@deepseek-ai\/dsh-session-format-v2-to-v3$/, replacement: pkg('packages/session/session-format-v2-to-v3') },
      { find: /^@deepseek-ai\/dsh-session-format-v3-to-v4$/, replacement: pkg('packages/session/session-format-v3-to-v4') },
      { find: /^@deepseek-ai\/dsh-session-format-v4-to-v5$/, replacement: pkg('packages/session/session-format-v4-to-v5') },
      { find: /^@deepseek-ai\/dsh-session$/, replacement: pkg('packages/core/session') },
      { find: '@deepseek-ai/dsh-compaction-image-offload/projection', replacement: pkg('packages/compaction/compaction-image-offload', 'projection.js') },
      { find: '@deepseek-ai/dsh-llm/discovery', replacement: pkg('packages/llm/llm', 'discovery.js') },
      { find: /^@deepseek-ai\/dsh-llm\/package\.json$/, replacement: fileURLToPath(new URL('../packages/llm/llm/package.json', import.meta.url)) },
      { find: /^@deepseek-ai\/dsh-llm$/, replacement: pkg('packages/llm/llm', 'assistant-stream.js') },
      { find: /^@deepseek-ai\/dsh-scope$/, replacement: pkg('packages/core/scope') },
      { find: /^@deepseek-ai\/dsh-timeout$/, replacement: pkg('packages/util/timeout') },
      { find: /^@deepseek-ai\/dsh-typert-protocol$/, replacement: pkg('packages/typert/protocol') },
      { find: /^@deepseek-ai\/dsh-brand$/, replacement: pkg('packages/util/brand') },
      { find: /^@deepseek-ai\/dsh-util-crypto$/, replacement: pkg('packages/util/crypto') },
      { find: /^@deepseek-ai\/dsh-util-values$/, replacement: pkg('packages/util/values') },
      { find: /^@deepseek-ai\/cordis$/, replacement: pkg('vendor/cordis') },
      { find: /^@deepseek-ai\/schemastery$/, replacement: pkg('vendor/schemastery') },
    ],
  },
  test: { include: ['tests/**/*.spec.ts'], testTimeout: 30000 },
})
