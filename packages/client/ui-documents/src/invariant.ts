// jscpd:ignore-start
import { type Context } from '@deepseek-ai/cordis'
import { type InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-documents'

export const name = 'client-ui-documents-invariant'
export const inject = ['invariants']

// No runtime invariant: document UI state is owned by the client session and has no independent
// event or mutable-data relation for this package to assert.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
// jscpd:ignore-end
