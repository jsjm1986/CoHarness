/** Browser resource identities; wire Session IDs and persisted Host data remain unchanged. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Authenticated account runtime; display names never contribute to identity. */
export type ClientRuntimeTarget =
  | { readonly kind: 'personal' }
  | { readonly kind: 'project'; readonly projectId: number; readonly projectName?: string }

declare const CLIENT_SESSION_KEY: unique symbol

/** Account-local browser key for exactly one runtime and durable Session. */
export type ClientSessionKey = SessionId & { readonly [CLIENT_SESSION_KEY]: true }

/** Runtime-qualified Session resource. Account lifetime is owned by the Client root. */
export interface ClientSessionAddress {
  readonly runtime: ClientRuntimeTarget
  readonly sessionId: SessionId
}

const PREFIX = 'dsh-session:v1:'

/** Encode a browser resource key without changing the Host identity.
 * @param runtime - owning account runtime.
 * @param sessionId - original Host Session ID.
 * @returns deterministic key, independent of project display names.
 */
export function clientSessionKey(runtime: ClientRuntimeTarget, sessionId: SessionId): ClientSessionKey {
  return `${PREFIX}${encodeURIComponent(JSON.stringify([runtime.kind === 'personal' ? null : runtime.projectId, sessionId]))}` as ClientSessionKey
}

/** Read persisted browser addressing metadata; acceptance still requires a current ACL-filtered catalog.
 * @param key - candidate browser key.
 * @returns original runtime and Session ID, or undefined for legacy/corrupt metadata.
 */
export function parseClientSessionKey(key: string): ClientSessionAddress | undefined {
  if (!key.startsWith(PREFIX)) return undefined
  let value: unknown
  try { value = JSON.parse(decodeURIComponent(key.slice(PREFIX.length))) }
  catch { return undefined /* Corrupt browser metadata is not a resource address. */ }
  if (!Array.isArray(value) || value.length !== 2 || typeof value[1] !== 'string' || value[1] === ''
    || (value[0] !== null && (typeof value[0] !== 'number' || !Number.isSafeInteger(value[0]) || value[0] <= 0))) return undefined
  const runtime: ClientRuntimeTarget = value[0] === null ? { kind: 'personal' } : { kind: 'project', projectId: value[0] as number }
  const sessionId = value[1] as SessionId
  return clientSessionKey(runtime, sessionId) === key ? { runtime, sessionId } : undefined
}

/**
 * Name one runtime target in a collision-free scope string. Shared by every
 * client-side aggregate that folds per-runtime maps (job ids collide across
 * runtimes; the scope prefix keeps them apart).
 * @param target - runtime target to name.
 * @returns `personal` or `project:<id>`.
 */
export function runtimeTargetKey(target: ClientRuntimeTarget): string {
  return target.kind === 'personal' ? 'personal' : `project:${String(target.projectId)}`
}
