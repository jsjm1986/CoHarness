/** Package-owned invariant companion for the optional desktop opener. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-open-in-app'
export const name = 'host-open-in-app-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = () => {
  // No runtime invariant: route ownership is enforced by webServer disposers.
}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
