/** The primary's early shell waits for one account- and Runtime-qualified index payload. */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { applyIndexInjections } from './apply-injections.ts'

/** Credential-free routing facts emitted only on an authenticated remote landing. */
export interface RemoteEntrySelection {
  readonly principalId: number
  readonly runtimeId: string
  readonly nodeId: string
  readonly nodeName: string
  readonly scope: 'personal' | `project:${number}`
  readonly language: 'zh' | 'en'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/** Decode the entry-owned marker without treating URL parameters as authority.
 * @returns the validated selection or undefined on an ordinary Host index.
 */
export function remoteEntrySelection(): RemoteEntrySelection | undefined {
  const marker = document.getElementById('dsh-runtime-bootstrap')
  if (marker === null) return undefined
  const value: unknown = JSON.parse(marker.textContent)
  if (!isRecord(value) || value.version !== 1 || typeof value.principalId !== 'number'
    || !Number.isSafeInteger(value.principalId) || value.principalId <= 0
    || typeof value.nodeName !== 'string' || typeof value.nodeId !== 'string' || !uuid.test(value.nodeId)
    || typeof value.runtimeId !== 'string' || !uuid.test(value.runtimeId)
    || typeof value.scope !== 'string' || !/^(?:personal|project:[1-9][0-9]*)$/u.test(value.scope)
    || value.language !== 'zh' && value.language !== 'en') throw new Error('Invalid remote entry selection')
  return {
    principalId: value.principalId, runtimeId: value.runtimeId, nodeId: value.nodeId,
    nodeName: value.nodeName, scope: value.scope as RemoteEntrySelection['scope'], language: value.language,
  }
}

/** Build the same-origin continuation of the entry selected when this document was created.
 * @param entry - authenticated entry selection.
 * @param mode - structured boot or native document rendering for legacy index taps.
 * @returns the exact target URL.
 */
export function remoteEntryUrl(entry: RemoteEntrySelection, mode: '1' | 'full'): URL {
  const url = new URL('/', location.origin)
  url.searchParams.set('dshRuntime', entry.runtimeId)
  url.searchParams.set('dshNode', entry.nodeId)
  url.searchParams.set('dshTarget', entry.scope)
  url.searchParams.set('dshBootstrap', mode)
  if (mode === 'full') url.searchParams.set('dshPrincipal', String(entry.principalId))
  return url
}

/** A changed account or expired session cannot own the entry document's input. */
export class RemoteEntryAccountChanged extends Error {}

function matchesIdentity(value: unknown, entry: RemoteEntrySelection): boolean {
  if (!isRecord(value) || value.version !== 1 || value.principalId !== entry.principalId
    || !isRecord(value.runtimeTarget) || value.runtimeTarget.runtimeId !== entry.runtimeId) return false
  return entry.scope === 'personal' ? value.runtimeTarget.kind === 'personal'
    : value.runtimeTarget.kind === 'project' && `project:${String(value.runtimeTarget.projectId)}` === entry.scope
}

class BootstrapScriptLoadError extends Error {}

function loadScript(src: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    const finish = (error?: Error): void => {
      signal.removeEventListener('abort', abort)
      script.onload = null
      script.onerror = null
      if (error === undefined) resolve()
      else { script.remove(); reject(error) }
    }
    const abort = (): void => {
      const reason: unknown = signal.reason
      finish(reason instanceof Error ? reason : new Error('Runtime bootstrap aborted', { cause: reason }))
    }
    script.onload = () => { finish() }
    script.onerror = () => { finish(new BootstrapScriptLoadError('A Runtime bootstrap script could not load')) }
    script.src = src
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else document.head.append(script)
  })
}

async function loadBootstrapScript(src: string, signal: AbortSignal): Promise<void> {
  try {
    await loadScript(src, signal)
  } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof BootstrapScriptLoadError)
      || !/^\/?plugins\/combo\.js\?\?/u.test(src)) throw error
    const url = new URL(src, document.baseURI)
    const revision = url.searchParams.get('rev')
    if (url.origin !== location.origin || revision === null || !/^[a-f0-9]{12}$/u.test(revision)) throw error
    await loadScript(src, signal)
  }
}

function isIndexInjection(value: unknown): value is IndexInjection {
  if (!isRecord(value)) return false
  const placement = value.placement === 'head' || value.placement === 'body'
  switch (value.kind) {
    case 'global': return typeof value.name === 'string'
    case 'script': return placement && typeof value.text === 'string'
    case 'script-src': return placement && typeof value.src === 'string'
    case 'script-preload': return typeof value.src === 'string'
    case 'style': return typeof value.text === 'string'
    case 'html': return placement && typeof value.html === 'string'
    default: return false
  }
}

/** Apply the selected Host's authenticated index rows without speculative preloads.
 * A failed same-origin, revision-pinned plugin bootstrap download receives one retry.
 * @param entry - exact account, computer and scope that rendered the first shell.
 * @param signal - owning document's lifetime.
 * @returns full-index when raw index transforms or an older Host require native rendering.
 */
export async function loadRemoteEntry(entry: RemoteEntrySelection, signal: AbortSignal): Promise<'injections' | 'full-index'> {
  const response = await fetch(remoteEntryUrl(entry, '1'), {
    signal, cache: 'no-store', redirect: 'error',
    headers: { accept: 'application/json', 'x-dsh-expected-principal-id': String(entry.principalId) },
  })
  const principal = response.headers.get('x-dsh-principal-id')
  if (response.status === 401 || principal !== null && principal !== String(entry.principalId)) {
    void response.body?.cancel().catch(() => { /* The withdrawn account cannot use this response even when cancellation fails. */ })
    throw new RemoteEntryAccountChanged('The account changed while opening this Runtime')
  }
  if (!response.ok || principal === null) {
    await response.body?.cancel()
    throw new Error(`Runtime bootstrap returned HTTP ${String(response.status)}`)
  }
  const contentType = response.headers.get('content-type')?.split(';')[0]
  if (contentType === 'text/html') { await response.body?.cancel(); return 'full-index' }
  if (contentType !== 'application/json') {
    await response.body?.cancel()
    throw new Error('Runtime bootstrap returned an unsupported document')
  }
  const payload: unknown = await response.json()
  if (!isRecord(payload) || payload.version !== 1) throw new Error('Invalid Runtime bootstrap document')
  if (payload.kind === 'full-index') return 'full-index'
  if (payload.kind !== 'injections' || !Array.isArray(payload.rows) || !payload.rows.every(isIndexInjection)) {
    throw new Error('Invalid Runtime bootstrap document')
  }
  const rows: readonly IndexInjection[] = payload.rows
  const identities = rows.filter((row): row is Extract<IndexInjection, { kind: 'global' }> =>
    row.kind === 'global' && row.name === '__DSH_DOCUMENT_IDENTITY__')
  if (identities.length !== 1 || !matchesIdentity(identities[0]?.value, entry)) {
    throw new Error('Runtime bootstrap returned a different document identity')
  }
  signal.throwIfAborted()
  await applyIndexInjections(rows, src => loadBootstrapScript(src, signal))
  return 'injections'
}
