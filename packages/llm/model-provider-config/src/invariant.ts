/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-model-provider-config`.
 * @module @deepseek-ai/dsh-model-provider-config/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-model-provider-config'

/** Cordis companion plugin name. */
export const name = 'model-provider-config-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Verify that every update event names the snapshot already committed by the live Provider. */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('model-provider-config/updated', (revision) => {
    const config = ctx.get('modelProviderConfig')
    if (config === undefined) {
      fail(`model-provider-config/updated for revision ${String(revision)} emitted without a live service`)
    }
    if (config.snapshot().revision !== revision) {
      fail(`model-provider-config/updated revision ${String(revision)} does not match the authoritative snapshot`)
    }
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
