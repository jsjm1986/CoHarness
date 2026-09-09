/** Package-owned invariant companion for the optional desktop opener UI. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-open-in-app'
export const name = 'client-ui-open-in-app-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = () => {
  // No runtime invariant: slot ownership and controller disposal are local UI contracts.
}
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
