/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-lazy-require`.
 * @module @deepseek-ai/dsh-lazy-require/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-lazy-require'

/** Cordis companion plugin name. */
export const name = 'lazy-require-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the loader caches a successful require per closure and
 * retains no cross-call mutable relationship or event history. */
const install: InvariantInstaller = () => {}

/** Register the package companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
