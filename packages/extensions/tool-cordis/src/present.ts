/** Pure replay-safe render intents for Cordis tools. */

import type { GenericCallView } from '@deepseek-ai/dsh-tools'

/**
 * Render provider-directory inspection.
 * @returns replay-safe generic call presentation.
 */
export function presentInspectListCall(): GenericCallView {
  return { card: 'generic', kind: 'read', title: 'List Cordis Inspect Providers' }
}

/**
 * Render one provider query.
 * @param args - target platform, provider, and method.
 * @returns replay-safe generic call presentation.
 */
export function presentInspectQueryCall(args: { platform: string; provider: string; method: string }): GenericCallView {
  return { card: 'generic', kind: 'read', title: `Query Cordis ${args.platform} ${args.provider}.${args.method}` }
}

/**
 * Render layered self-inspection.
 * @param args - optional Plugin and Package identity.
 * @returns replay-safe generic call presentation.
 */
export function presentInspectSelfCall(args: { pluginId?: string; packageId?: string }): GenericCallView {
  const target = args.pluginId === undefined
    ? 'dynamic Cordis Plugins'
    : args.packageId === undefined ? args.pluginId : `${args.pluginId}/${args.packageId}`
  return { card: 'generic', kind: 'read', title: `Inspect ${target}` }
}
