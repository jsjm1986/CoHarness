/** Package-owned invariant companion for the Gateway archive synchronization provider. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'archive-gateway-invariant'
export const inject = ['invariants']
/** No runtime invariant: the provider synchronizes authoritative persistence and the registry snapshot directly. */
const install: InvariantInstaller = () => {}

/** Register the archive provider's invariant ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-archive-gateway', install))
