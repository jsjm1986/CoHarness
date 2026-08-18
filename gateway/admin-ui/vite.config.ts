import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  resolve: {
    // The admin surface mounts the shared Models plugin from the workspace
    // source. These aliases keep its value imports on the same React instance
    // while reusing the real runtime, schema form, and primitive components.
    alias: {
      '@deepseek-ai/dsh-client-runtime/client': resolve(__dirname, '../../packages/client/runtime/src/client/contract/store.ts'),
      '@deepseek-ai/dsh-client-schema-form': resolve(__dirname, '../../packages/client/schema-form/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-primitives': resolve(__dirname, 'src/model-settings-primitives.ts'),
    },
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: '../public/admin',
    emptyOutDir: true,
  },
  server: {
    fs: {
      allow: [resolve(__dirname, '../..')],
    },
  },
  test: {
    environment: 'happy-dom',
  },
})
