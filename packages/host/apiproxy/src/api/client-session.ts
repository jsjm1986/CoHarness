/** Browser resource identities; wire Session IDs and persisted Host data remain unchanged. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable Gateway allocation, independent of the running process generation. */
export type ClientRuntimeId = Branded<'GatewayRuntimeId'>

/** Registered computer; names are display metadata and never select resources. */
export type ClientComputerId = Branded<'RuntimeNodeId'>

/** Exact managed allocation and optional authenticated computer display metadata. */
export interface ClientRuntimeLocation {
  readonly runtimeId?: ClientRuntimeId
  readonly nodeId?: ClientComputerId
  readonly nodeName?: string
}

/** Authenticated account runtime; display names never contribute to identity. */
export type ClientRuntimeTarget = (
  | { readonly kind: 'personal' }
  | { readonly kind: 'project'; readonly projectId: number; readonly projectName?: string }
) & ClientRuntimeLocation

declare const CLIENT_SESSION_KEY: unique symbol

/** Account-local browser key for exactly one runtime and durable Session. */
export type ClientSessionKey = SessionId & { readonly [CLIENT_SESSION_KEY]: true }

/** Runtime-qualified Session resource. Account lifetime is owned by the Client root. */
export interface ClientSessionAddress {
  readonly runtime: ClientRuntimeTarget
  readonly sessionId: SessionId
}

const PREFIX = 'dsh-session:v1:'
const EXACT_PREFIX = 'dsh-session:v2:'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** Encode a browser resource key without changing the Host identity.
 * @param runtime - owning account runtime.
 * @param sessionId - original Host Session ID.
 * @returns deterministic key, independent of project display names.
 */
export function clientSessionKey(runtime: ClientRuntimeTarget, sessionId: SessionId): ClientSessionKey {
  if (runtime.runtimeId !== undefined) {
    return `${EXACT_PREFIX}${encodeURIComponent(JSON.stringify([runtime.kind === 'personal' ? null : runtime.projectId, runtime.runtimeId, sessionId]))}` as ClientSessionKey
  }
  return `${PREFIX}${encodeURIComponent(JSON.stringify([runtime.kind === 'personal' ? null : runtime.projectId, sessionId]))}` as ClientSessionKey
}

/** Read persisted browser addressing metadata; acceptance still requires a current ACL-filtered catalog.
 * @param key - candidate browser key.
 * @returns original runtime and Session ID, or undefined for legacy/corrupt metadata.
 */
export function parseClientSessionKey(key: string): ClientSessionAddress | undefined {
  const exact = key.startsWith(EXACT_PREFIX), prefix = exact ? EXACT_PREFIX : PREFIX
  if (!key.startsWith(prefix)) return undefined
  let value: unknown
  try { value = JSON.parse(decodeURIComponent(key.slice(prefix.length))) }
  catch { return undefined /* Corrupt browser metadata is not a resource address. */ }
  if (!Array.isArray(value) || value.length !== (exact ? 3 : 2)
    || (value[0] !== null && (typeof value[0] !== 'number' || !Number.isSafeInteger(value[0]) || value[0] <= 0))) return undefined
  if (exact && (typeof value[1] !== 'string' || !UUID.test(value[1]))) return undefined
  const original: unknown = value[exact ? 2 : 1]
  if (typeof original !== 'string' || original === '') return undefined
  const location = exact ? { runtimeId: value[1] as ClientRuntimeId } : {}
  const runtime: ClientRuntimeTarget = value[0] === null ? { kind: 'personal', ...location } : { kind: 'project', projectId: value[0] as number, ...location }
  const sessionId = original as SessionId
  return clientSessionKey(runtime, sessionId) === key ? { runtime, sessionId } : undefined
}

/**
 * Name one runtime target in a collision-free scope string. Shared by every
 * client-side aggregate that folds per-runtime maps (job ids collide across
 * runtimes; the scope prefix keeps them apart).
 * @param target - runtime target to name.
 * @returns an exact allocation key, or the standalone legacy owner key.
 */
export function runtimeTargetKey(target: ClientRuntimeTarget): string {
  const owner = target.kind === 'personal' ? 'personal' : `project:${String(target.projectId)}`
  return target.runtimeId === undefined ? owner : `${owner}:runtime:${target.runtimeId}`
}

/**
 * Address an authenticated Runtime without consulting another tab's scope cookie.
 * @param url - same-origin API or stream address owned by the caller.
 * @param target - selected allocation; standalone targets retain their owner selector.
 */
export function addressRuntimeUrl(url: URL, target: ClientRuntimeTarget): void {
  url.searchParams.set('dshTarget', target.kind === 'personal' ? 'personal' : `project:${String(target.projectId)}`)
  if (target.runtimeId !== undefined) url.searchParams.set('dshRuntime', target.runtimeId)
}
