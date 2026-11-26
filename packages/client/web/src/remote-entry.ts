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

function markRemoteBootStage(stage: string): void {
  try {
    performance.mark(`dsh:boot:${stage}`)
  } catch { /* Boot telemetry cannot fail remote bootstrap in restricted runtimes. */ }
}

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

const BOOTSTRAP_PRELOAD_HEADER = 'x-dsh-bootstrap-preload'

/** Structured boot carries early script outcomes to the page's module system. */
export type RemoteIndex =
  | { readonly kind: 'full-index' }
  | { readonly kind: 'injections'; readonly preloadedBundles: ReadonlyMap<string, 'executed' | 'load-failed'> }

class BootstrapScriptLoadError extends Error {}

function isRevisionedSameOriginCombo(src: string): boolean {
  if (!/^\/?plugins\/combo\.js\?\?[^?&#]+&rev=[a-f0-9]{12}$/u.test(src)) return false
  const url = new URL(src, document.baseURI)
  return url.origin === location.origin && url.pathname === '/plugins/combo.js'
}

const applicationResource = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*\/client\.js$/u

function earlyApplicationBatch(rows: readonly IndexInjection[]): string | undefined {
  const graphs = rows.filter(row => row.kind === 'global' && row.name === '__DSH_BOOT__')
  const graph = graphs[0]
  if (graphs.length !== 1 || graph?.kind !== 'global' || !isRecord(graph.value) || !Array.isArray(graph.value.batches)) return undefined
  const batches: readonly unknown[] = graph.value.batches
  for (const row of rows) {
    if (row.kind !== 'script-preload' || !isRevisionedSameOriginCombo(row.src)) continue
    const resources = row.src.slice(row.src.indexOf('??') + 2, row.src.indexOf('&rev=')).split(',')
    if (resources.length > 1 && resources.every(resource => applicationResource.test(resource))
      && batches.some(batch => isRecord(batch) && batch.phase === 'application' && batch.url === row.src
        && Array.isArray(batch.entries) && batch.entries.length === resources.length)) return row.src
  }
  return undefined
}

function loadScript(
  src: string,
  signal: AbortSignal,
  options: { fetchPriority: 'high' | 'low'; removeOnLoad?: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.async = true
    script.fetchPriority = options.fetchPriority
    const finish = (error?: Error): void => {
      signal.removeEventListener('abort', abort)
      script.onload = null
      script.onerror = null
      if (error === undefined) {
        if (options.removeOnLoad === true) script.remove()
        resolve()
      } else {
        script.remove()
        reject(error)
      }
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
    await loadScript(src, signal, { fetchPriority: 'high' })
  } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof BootstrapScriptLoadError) || !isRevisionedSameOriginCombo(src)) throw error
    await loadScript(src, signal, { fetchPriority: 'high' })
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

/** Apply authenticated index rows. Start sequential bootstrap scripts before one
 * revisioned application batch, and pass the batch outcome to the module system.
 * A failed same-origin, revision-pinned bootstrap download receives one retry.
 * @param entry - exact account, computer and scope that rendered the first shell.
 * @param signal - owning document's lifetime.
 * @returns early script outcomes, or full-index when the Host requires native rendering.
 */
export async function loadRemoteEntry(entry: RemoteEntrySelection, signal: AbortSignal): Promise<RemoteIndex> {
  const response = await fetch(remoteEntryUrl(entry, '1'), {
    signal, cache: 'no-store', redirect: 'error',
    headers: {
      accept: 'application/json',
      'x-dsh-expected-principal-id': String(entry.principalId),
      [BOOTSTRAP_PRELOAD_HEADER]: '1',
    },
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
  if (contentType === 'text/html') { await response.body?.cancel(); return { kind: 'full-index' } }
  if (contentType !== 'application/json') {
    await response.body?.cancel()
    throw new Error('Runtime bootstrap returned an unsupported document')
  }
  const payload: unknown = await response.json()
  if (!isRecord(payload) || payload.version !== 1) throw new Error('Invalid Runtime bootstrap document')
  if (payload.kind === 'full-index') return { kind: 'full-index' }
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
  markRemoteBootStage('bootstrap-json-ready')
  const preload = earlyApplicationBatch(rows)
  const preloadController = new AbortController()
  const preloadSignal = AbortSignal.any([signal, preloadController.signal])
  const preloadedBundles = new Map<string, 'executed' | 'load-failed'>()
  let preloadWork: Promise<void> | undefined
  try {
    await applyIndexInjections(rows, (src) => {
      const bootstrap = loadBootstrapScript(src, signal)
      const loader = (globalThis as { __ModuleLoader__?: { mode?: unknown } }).__ModuleLoader__
      if (preload !== undefined && preloadWork === undefined && loader?.mode === 'queue') {
        preloadWork = loadScript(`${preload}&dshAssetPreload=1`, preloadSignal, { fetchPriority: 'low', removeOnLoad: true }).then(
          () => { preloadedBundles.set(preload, 'executed') },
          () => { preloadedBundles.set(preload, 'load-failed') },
        )
      }
      return bootstrap
    })
    if (preloadWork !== undefined) await preloadWork
    signal.throwIfAborted()
    markRemoteBootStage('bootstrap-scripts-ready')
    return { kind: 'injections', preloadedBundles }
  } catch (error) {
    preloadController.abort(error)
    throw error
  }
}
