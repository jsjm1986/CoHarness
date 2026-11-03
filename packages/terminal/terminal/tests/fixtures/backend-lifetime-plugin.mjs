/** Hold an allocated native PTY before publication by its registry. */
const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
const root = new URL('../../../../../', import.meta.url)
const backend = await import(new URL(`packages/terminal/terminal-bash/${mode === 'src' ? 'src/index.ts' : 'lib/index.js'}`, root))
export const Config = backend.Config
export const inject = backend.inject
export const entered = Promise.withResolvers()
export const release = Promise.withResolvers()
export let withdraw

export function apply(ctx, config) {
  const native = new backend.BashTerminalBackend(ctx, {
    ...config, shellPath: '/bin/bash', shellArgs: ['--noprofile', '--norc', '-i'],
  })
  withdraw = ctx.terminals.registerBackend({ type: native.type, async spawn(spec) {
    const session = await native.spawn(spec)
    entered.resolve({ session, signal: spec.signal })
    await release.promise
    return session
  } })
}
