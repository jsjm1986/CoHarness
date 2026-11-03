/** Application-owned launch identity survives replacement of the transport implementation. */
import type { Context } from '@deepseek-ai/cordis'
import type { KeyObject } from 'node:crypto'
import type { GatewayRuntimeCredential } from './index.ts'

/** Fully parsed launch credential and decoded signature-verification key. */
export interface LaunchAuthority {
  readonly credential: GatewayRuntimeCredential
  readonly publicKey: KeyObject
}

const LAUNCH_AUTHORITY = Symbol.for('dsh.gateway-runtime.launch-authority')

interface LaunchAuthorityContext extends Context {
  readonly [LAUNCH_AUTHORITY]?: LaunchAuthority
}

/**
 * Retain one validated launch identity until application disposal.
 * @param ctx - provider context whose application owns the credential.
 * @param read - reads and validates the private channel only when no identity is retained.
 * @returns the same application-owned authority across provider and module replacement.
 */
export function launchAuthorityOf(ctx: Context, read: () => LaunchAuthority): LaunchAuthority {
  const root = ctx.root as LaunchAuthorityContext
  const existing = root[LAUNCH_AUTHORITY]
  if (existing !== undefined) return existing
  const authority = read()
  root.effect(() => {
    Object.defineProperty(root, LAUNCH_AUTHORITY, { configurable: true, value: authority })
    return () => { Reflect.deleteProperty(root, LAUNCH_AUTHORITY) }
  }, 'gateway-runtime: application launch authority')
  return authority
}
