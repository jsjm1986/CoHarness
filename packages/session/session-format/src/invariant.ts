/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-format`.
 * @module @deepseek-ai/dsh-session-format/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-format'

/** Cordis companion plugin name. */
export const name = 'session-format-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the library validates detached artifact values and owns no event stream or mutable runtime state. */
const install: InvariantInstaller = () => {}

/** Register the package companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
