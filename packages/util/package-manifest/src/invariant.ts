/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-package-manifest`.
 * @module @deepseek-ai/dsh-package-manifest/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-package-manifest'

/** Cordis companion plugin name. */
export const name = 'package-manifest-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: this type-only package owns no state or event stream to validate. */
const install: InvariantInstaller = () => {}

/** Register the empty invariant companion required by the package gate. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
