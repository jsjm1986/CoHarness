/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-http-proxy`.
 * @module @deepseek-ai/dsh-http-proxy/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-http-proxy'

/** Cordis companion plugin name. */
export const name = 'http-proxy-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: this startup library exposes no Cordis event stream or owned mutable data; egress tests verify routing. */
const install: InvariantInstaller = () => {}

/** Register the package companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
