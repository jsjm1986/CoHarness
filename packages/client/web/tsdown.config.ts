import { staticLinked } from '../tsdown.client.ts'

const linked = staticLinked(
  '@deepseek-ai/dsh-client-web',
  ['lib/types/index.js', 'lib/types/boot.js', 'lib/types/seed.js'],
)

// Publish stable entry paths so the shell keeps a dynamic edge to its platform modules.
export default (options: Parameters<typeof linked>[0]) => linked(options).map(config => ({
  ...config,
  deps: { ...config.deps, neverBundle: [/^\.\/(?:boot|seed)\.js$/u] },
}))
