/** Verified ownership of browser-local Session presentation records. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ISessions } from './contract/sessions.ts'

/**
 * Identify a visible Session's private presentation storage without inferring local authority.
 * @param sessions - current visible catalog and runtime ownership.
 * @param sessionId - Session whose presentation is stored.
 * @param authorityRequired - Host-declared Gateway requirement; absent until verified.
 * @param accountId - verified Gateway account, absent after invalidation.
 * @returns an account/runtime/Session key, or undefined without current ownership proof.
 */
export function sessionPersistenceKey(
  sessions: Pick<ISessions, 'list' | 'runtimeIdentityFor'>,
  sessionId: SessionId,
  authorityRequired: boolean | undefined,
  accountId: number | undefined,
): string | undefined {
  if (sessions.list.getSnapshot().byId[sessionId] === undefined) return undefined
  const principal = authorityRequired === false ? 'local'
    : authorityRequired === true && accountId !== undefined ? `account:${accountId}` : undefined
  if (principal === undefined) return undefined
  const target = sessions.runtimeIdentityFor === undefined
    ? { kind: 'personal' as const } : sessions.runtimeIdentityFor(sessionId)
  if (target === undefined) return undefined
  const runtime = target.kind === 'project' ? ['project', target.projectId] : ['personal']
  return JSON.stringify([principal, runtime, sessionId])
}
