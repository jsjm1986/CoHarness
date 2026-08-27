/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-userdoc-upload`.
 * @module @deepseek-ai/dsh-client-userdoc-upload/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-userdoc-upload'

/** Cordis companion plugin name. */
export const name = 'client-userdoc-upload-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the uploader is a browser-only functional state
 * machine. It owns no Cordis service, event stream, or cross-plugin mutable
 * relation, so its behavior is covered by protocol and cancellation tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
