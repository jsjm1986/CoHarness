import react from '@vitejs/plugin-react'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { defineConfig } from 'vitest/config'

const gzipAsset = promisify(gzip)

export default defineConfig({
  plugins: [react(), {
    name: 'precompress-admin-assets',
    apply: 'build',
    async writeBundle({ dir }, bundle) {
      if (dir === undefined) return
      await Promise.all(Object.keys(bundle).map(async (name) => {
        if (!name.startsWith('assets/') || !/\.(?:js|css)$/u.test(name)) return
        const file = join(dir, name)
        const bytes = await readFile(file)
        if (bytes.byteLength < 1024) return
        const source = await gzipAsset(bytes, { level: 9 })
        if (source.byteLength < bytes.byteLength) {
          await writeFile(file + '.gz', source)
        }
      }))
    },
  }],
  base: '/admin/',
  resolve: {
    // The admin surface mounts the shared Models plugin from the workspace
    // source. These aliases keep its value imports on the same React instance
    // while reusing the real runtime and primitive components.
    alias: {
      '@deepseek-ai/dsh-host-apiproxy/api': resolve(__dirname, '../../packages/host/apiproxy/src/api/index.ts'),
      '@deepseek-ai/cordis': resolve(__dirname, '../../vendor/cordis/src/index.ts'),
      '@deepseek-ai/cosmokit': resolve(__dirname, '../../vendor/cosmokit/src/index.ts'),
      '@deepseek-ai/schemastery': resolve(__dirname, '../../vendor/schemastery/src/index.ts'),
      '@deepseek-ai/dsh-client-runtime/client': resolve(__dirname, '../../packages/client/runtime/src/client/contract/store.ts'),
      '@deepseek-ai/dsh-client-ui-primitives': resolve(__dirname, 'src/model-settings-primitives.ts'),
      '@deepseek-ai/dsh-typert-protocol/remote-info': resolve(__dirname, '../../packages/typert/protocol/src/remote-info.ts'),
    },
    dedupe: ['react', 'react-dom', 'lucide-react', 'zod'],
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
    server: {
      deps: {
        // Workspace sources import zustand outside the vite root; externalized
        // copies would resolve their react import against a second instance,
        // so it stays in the vite pipeline where dedupe applies.
        inline: [/zustand/],
      },
    },
  },
})
