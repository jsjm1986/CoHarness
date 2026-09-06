/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-util-values`.
 * @module @deepseek-ai/dsh-util-values/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-util-values'

/** Cordis companion plugin name. */
export const name = 'util-values-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: these value helpers retain no mutable state or event history between calls. */
const install: InvariantInstaller = () => {}

/** Register the package companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
