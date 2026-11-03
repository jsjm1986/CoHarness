/** Verified ownership of browser-local Session presentation records. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { parseClientSessionKey } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ISessions } from './contract/sessions.ts'

/**
 * Identify private Session presentation storage under the current verified principal.
 * @param sessions - current visible catalog and runtime ownership.
 * @param sessionId - Session whose presentation is stored.
 * @param authorityRequired - Host-declared Gateway requirement; absent before verification or during transport renewal.
 * @param accountId - document-confirmed Gateway account, absent after account invalidation.
 * @param intent - `forget` permits removal after the Session leaves the visible catalog.
 * @returns an account/runtime/Session key, or undefined without current ownership proof.
 */
export function sessionPersistenceKey(
  sessions: Pick<ISessions, 'list' | 'runtimeIdentityFor'>,
  sessionId: SessionId,
  authorityRequired: boolean | undefined,
  accountId: number | undefined,
  intent?: 'forget',
): string | undefined {
  if (intent !== 'forget' && sessions.list.getSnapshot().byId[sessionId] === undefined) return undefined
  const principal = authorityRequired === false ? 'local'
    : accountId !== undefined ? `account:${accountId}` : undefined
  if (principal === undefined) return undefined
  const address = sessions.runtimeIdentityFor === undefined ? undefined : parseClientSessionKey(sessionId)
  const target = sessions.runtimeIdentityFor === undefined
    ? { kind: 'personal' as const } : sessions.runtimeIdentityFor(sessionId) ?? (intent === 'forget' ? address?.runtime : undefined)
  if (target === undefined) return undefined
  const runtime = target.runtimeId !== undefined ? ['runtime', target.runtimeId]
    : target.kind === 'project' ? ['project', target.projectId] : ['personal']
  const original = sessions.runtimeIdentityFor === undefined ? sessionId : address?.sessionId ?? sessionId
  return JSON.stringify([principal, runtime, original])
}
