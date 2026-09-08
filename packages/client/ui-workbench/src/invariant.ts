/** Package-owned invariant companion for the UI workbench. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-workbench'

/** Cordis companion plugin name. */
export const name = 'client-ui-workbench-invariant'
/** Service required before registering package ownership. */
export const inject = ['invariants']

/** The plugin consumes viewport state; slot ownership and Session routing are enforced by their providers. */
const install: InvariantInstaller = () => {
  // No runtime invariant: ownership and lifecycle are enforced by Cordis slots and the viewport capability.
}

/** Register the package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
