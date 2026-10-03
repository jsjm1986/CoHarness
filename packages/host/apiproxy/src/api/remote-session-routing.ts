/** Session addresses shared by this application's Remote routing and Host authorization. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** A Remote operation's Session address, access check, and explicit execution attribution owner. */
export type RemoteSessionPolicy = {
  readonly path: readonly string[]
} & ({ readonly action: 'read' } | {
  readonly action: 'write' | 'approve'
  /** Request starts human execution; operation owns mixed commands/callbacks; none changes no execution origin. */
  readonly execution: 'request' | 'operation' | 'none'
})

/** Explicit application-owned Session operations; unlisted JSON is never inferred as a Session address. */
export const REMOTE_SESSION_POLICIES: Readonly<Record<string, RemoteSessionPolicy>> = Object.freeze({
  'commands/list': { action: 'read', path: ['agentId'] },
  'commands/execute': { action: 'write', path: ['agentId'], execution: 'operation' },
  'fileReferences/list': { action: 'read', path: ['agentId'] },
  'sessionReferenceResolver/candidates': { action: 'read', path: ['agentId'] },
  'goals/create': { action: 'write', path: ['agentId'], execution: 'request' },
  'goals/edit': { action: 'write', path: ['agentId'], execution: 'request' },
  'goals/pause': { action: 'write', path: ['agentId'], execution: 'none' },
  'goals/resume': { action: 'write', path: ['agentId'], execution: 'request' },
  'goals/complete': { action: 'write', path: ['agentId'], execution: 'none' },
  'goals/clear': { action: 'write', path: ['agentId'], execution: 'none' },
  'messageFeedback/list': { action: 'read', path: ['request', 'sessionId'] },
  'messageFeedback/put': { action: 'write', path: ['request', 'sessionId'], execution: 'none' },
  'messageFeedback/delete': { action: 'write', path: ['request', 'sessionId'], execution: 'none' },
  'dynamicCordisRunner/runHostHalf': { action: 'approve', path: ['agentId'], execution: 'operation' },
  'dynamicCordisRunner/getClientCode': { action: 'read', path: ['agentId'] },
  'dynamicCordisRunner/settleUserRun': { action: 'write', path: ['agentId'], execution: 'operation' },
  'dynamicCordisRunner/stopFromPanel': { action: 'write', path: ['agentId'], execution: 'none' },
  'dynamicCordisRunner/undefineFromPanel': { action: 'write', path: ['agentId'], execution: 'none' },
  'dynamicCordisRunner/reportRenderFailure': { action: 'write', path: ['agentId'], execution: 'none' },
  'dynamicCordisRunner/reportClientGuardFailure': { action: 'write', path: ['agentId'], execution: 'none' },
  'dynamicCordisRunner/resolveInspectQuery': { action: 'write', path: ['agentId'], execution: 'none' },
  'goals/get': { action: 'read', path: ['agentId'] },
  'subagents/list': { action: 'read', path: ['parentSessionId'] },
  'subagents/prompt': { action: 'write', path: ['request', 'parentSessionId'], execution: 'request' },
  'subagents/interruptByParent': { action: 'write', path: ['parentSessionId'], execution: 'none' },
  'agentPresets/select': { action: 'write', path: ['agentId'], execution: 'none' },
  'schedule/list': { action: 'read', path: ['sessionId'] },
  'schedule/history': { action: 'read', path: ['sessionId'] },
  'schedule/delete': { action: 'write', path: ['sessionId'], execution: 'none' },
  'schedule/update': { action: 'write', path: ['sessionId'], execution: 'none' },
  'agentTeams/view': { action: 'read', path: ['agentId'] },
  'agentTeams/createTask': { action: 'write', path: ['agentId'], execution: 'request' },
  'agentTeams/updateTask': { action: 'write', path: ['agentId'], execution: 'request' },
  'sessionFeedback/record': { action: 'write', path: ['request', 'sessionId'], execution: 'none' },
})

/**
 * Read one declared Session address without interpreting arbitrary request content.
 * @param endpoint - exact Remote namespace and method.
 * @param args - wire arguments, which the Host still validates and authorizes.
 * @returns the primary Session identity, or absence for unscoped/invalid requests.
 */
export function remoteSessionId(endpoint: string, args: Readonly<Record<string, unknown>>): SessionId | undefined {
  const policy = REMOTE_SESSION_POLICIES[endpoint]
  if (policy === undefined) return undefined
  let value: unknown = args
  for (const field of policy.path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, field)) return undefined
    value = Reflect.get(value, field)
  }
  return typeof value === 'string' && value.length > 0 ? value as SessionId : undefined
}

/** Rewrite only declared Session address fields for a browser transport.
 * @param endpoint - mounted Remote method.
 * @param args - original arguments; content and unrelated strings remain untouched.
 * @param map - map each declared Session ID to its wire identity.
 * @param scopeWire - generated Agent lookup field, when this Remote is scoped.
 * @returns original object when no declared address changed, otherwise a detached path copy.
 */
export function mapRemoteSessionIds(
  endpoint: string,
  args: Readonly<Record<string, unknown>>,
  map: (id: SessionId) => SessionId,
  scopeWire?: string,
): Readonly<Record<string, unknown>> {
  const policy = REMOTE_SESSION_POLICIES[endpoint]
  const paths: readonly (readonly string[])[] = [
    ...(policy === undefined ? [] : [policy.path]),
    ...(scopeWire === undefined ? [] : [[scopeWire]]),
    ...(endpoint.startsWith('terminal/') ? [['sessionId']] : []),
    ...(endpoint === 'subagents/prompt' ? [['request', 'childSessionId']] : []),
    ...(endpoint === 'subagents/interruptByParent' ? [['childSessionId']] : []),
  ]
  let result = args
  for (const path of paths) {
    const rewrite = (value: unknown, offset: number): unknown => {
      if (offset === path.length) return typeof value === 'string' ? map(value as SessionId) : value
      const field = path[offset] as string
      if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, field)) return value
      const before: unknown = Reflect.get(value, field)
      const after = rewrite(before, offset + 1)
      return before === after ? value : { ...value, [field]: after }
    }
    result = rewrite(result, 0) as Readonly<Record<string, unknown>>
  }
  return result
}
