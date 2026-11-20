/** Session durability evidence is independent of process-range termination. */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { posix } from 'node:path'
import type { RuntimeTarget } from './instances.ts'

/** A managed Runtime's checkpoint outcome or the supervisor's termination evidence. */
export type RuntimeShutdownOutcome = 'confirmed' | 'failed' | 'timeout' | 'forced' | 'unconfirmed'

/** Process and Session evidence for one selected node-local Runtime generation. */
export type RuntimeDrainEntry = { readonly target: RuntimeTarget } & (
  | { readonly generation: number | null; readonly state: 'queued' }
  | { readonly generation: number; readonly state: 'stopping'; readonly shutdownOutcome?: RuntimeShutdownOutcome }
  | { readonly generation: number; readonly state: 'stopped'; readonly shutdownOutcome: RuntimeShutdownOutcome }
  | { readonly generation: number | null; readonly state: 'failed'; readonly error: string; readonly shutdownOutcome?: RuntimeShutdownOutcome }
)

/** Snapshot of a planned node drain. A null generation means discovery could not bind the exact allocation. */
export interface RuntimeDrainReport {
  readonly inventory: 'pending' | 'complete' | 'failed'
  readonly inventoryError?: string
  readonly deadlineExceeded: boolean
  readonly succeeded: boolean
  readonly runtimes: readonly RuntimeDrainEntry[]
}

/** Gateway-owned node drain, including a partial report when the process deadline expires. */
export interface RuntimeDrain {
  /** All selected stop attempts have settled and the report has its terminal inventory status. */
  readonly completion: Promise<RuntimeDrainReport>
  /** Record the node deadline and snapshot outcomes already observed by the Gateway. */
  expire(): RuntimeDrainReport
}

/** The stopped or restarted generation's Session durability evidence on Admin responses. */
export const RUNTIME_SHUTDOWN_OUTCOME_HEADER = 'x-dsh-runtime-shutdown-outcome'

/**
 * Identify the storage methods a managed Host needs for the final checkpoint.
 * @param pathname - request path without its query string.
 * @param method - request method.
 * @returns whether this operation can be admitted by the planned-stop storage credential check.
 */
export function isRuntimeShutdownStorageRequest(pathname: string, method: string | undefined): boolean {
  return method === 'POST' && pathname === '/internal/runtime/session/append'
    || method === 'GET' && pathname === '/internal/runtime/session/read-from'
}

/** Which evidence a Runtime can report before it exits. */
export type RuntimeCheckpointOutcome = Exclude<RuntimeShutdownOutcome, 'unconfirmed'>

/** @param value - a supervisor's untrusted receipt field. @returns a recognized checkpoint outcome. */
export function runtimeCheckpointOutcome(value: unknown): RuntimeCheckpointOutcome | undefined {
  if (value === 'confirmed' || value === 'failed' || value === 'timeout' || value === 'forced') return value
  return undefined
}

/** @param code - exit status after a managed signal request. @returns the checkpoint outcome carried by a reserved code. */
export function signalShutdownOutcome(code: number | null): RuntimeCheckpointOutcome | undefined {
  switch (code) {
    case 80: return 'confirmed'
    case 81: return 'failed'
    case 82: return 'timeout'
    case 83: return 'forced'
    default: return undefined
  }
}

/**
 * Derive a systemd receipt path from the same generation and fingerprint used in the unit identity.
 * @param dshHome - the unit's writable Harness home.
 * @param generation - the captured allocation generation.
 * @param credentialHash - the fingerprint identifying this launch even after a database restore.
 * @returns the Runtime-owned receipt path.
 */
export function systemdRuntimeShutdownReceipt(dshHome: string, generation: number, credentialHash: string): string {
  return posix.join(dshHome, `.gateway-shutdown-${String(generation)}-${credentialHash}`)
}

/** @param path - exact-generation receipt in protected local supervisor state. @returns the outcome or `unconfirmed`. */
export async function readRuntimeShutdownReceipt(path: string): Promise<RuntimeShutdownOutcome> {
  const value = await readReceiptLine(path, 16)
  return runtimeCheckpointOutcome(value) ?? 'unconfirmed'
}

/**
 * Verify a Runtime-writable receipt after confirming termination.
 * @param path - exact-generation receipt path.
 * @param credentialPath - private systemd credential source for this allocation.
 * @returns the authenticated outcome or `unconfirmed`.
 */
export async function readSystemdShutdownReceipt(path: string, credentialPath: string): Promise<RuntimeShutdownOutcome> {
  const value = await readReceiptLine(path, 64)
  if (value === undefined) return 'unconfirmed'
  const [label, proof, extra] = value.split('\t')
  const outcome = runtimeCheckpointOutcome(label)
  if (outcome === undefined || proof === undefined || extra !== undefined || !/^[\w-]{43}$/u.test(proof)) return 'unconfirmed'
  try {
    const file = await open(credentialPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 65_536) return 'unconfirmed'
      const { token } = JSON.parse(await file.readFile('utf8')) as { token?: unknown }
      if (typeof token !== 'string' || token === '') return 'unconfirmed'
      const expected = createHmac('sha256', token).update(['dsh-gateway-shutdown-v1', posix.basename(path), outcome].join('\0')).digest('base64url')
      return timingSafeEqual(Buffer.from(expected), Buffer.from(proof)) ? outcome : 'unconfirmed'
    } finally { await file.close() }
  } catch {
    // A masked legacy unit or an interrupted stop can lack the original credential.
    return 'unconfirmed'
  }
}

async function readReceiptLine(path: string, limit: number): Promise<string | undefined> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > limit) return undefined
      const bytes = Buffer.alloc(limit + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      const value = bytes.subarray(0, bytesRead).toString('utf8')
      return bytesRead <= limit && /^[^\r\n]+\n$/u.test(value) ? value.slice(0, -1) : undefined
    } finally { await handle.close() }
  } catch {
    // A process can stop without a readable receipt, including after an interrupted or failed publication.
    return undefined
  }
}
