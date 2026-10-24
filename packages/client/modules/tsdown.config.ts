import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-client-modules',
  ['lib/types/index.js'],
  {
    lib: {
      define: {
        'process.env.DSH_CLIENT_COMMIT_HASH': JSON.stringify(process.env.DSH_CLIENT_COMMIT_HASH) ?? 'undefined',
      },
    },
  },
)
