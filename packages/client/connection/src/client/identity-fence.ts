/** One browser document's authenticated Gateway identity and request lifetime. */
import { addressRuntimeUrl, runtimeTargetKey, type ClientRuntimeTarget } from '@deepseek-ai/dsh-host-apiproxy/api'
import { ApiTransportError } from './api.ts'

const RESPONSE_ID = 'x-dsh-principal-id'
const EXPECTED_ID = 'x-dsh-expected-principal-id'

const ADVISORY_READS = new Set([
  '/api/agentPresets/list',
  '/api/dynamicCordisRunner/inventory',
  '/api/llm.models',
  '/api/llm.providers',
  '/api/session.models',
  '/api/skill.list',
  '/api/subagents/list',
  '/api/terminal/list',
])
const HTTP1_ADVISORY_READS = new Set(['/api/permissionPresets/catalog', '/api/settings.describe'])
const HTTP1_NAVIGATION_READS = new Set(['/api/session.list', '/api/session.historyIndex'])
const HTTP1_SYNCHRONIZATION = new Set(['/api/session.activate', '/api/dynamicCordisRunner/syncInspectManifest'])
const HTTP1_CONVERSATION_ACTIONS = new Set([
  '/api/prepare/v1/session.create',
  '/api/admit/v1/session.prompt',
  '/api/admit/v1/session.status',
])

function navigationRead(url: URL, method: string): boolean {
  if (method === 'POST') return HTTP1_NAVIGATION_READS.has(url.pathname)
  const params = url.searchParams
  return method === 'GET' && url.pathname === '/account/api/workbench/rows'
    && params.get('kind') === 'workspaces' && params.get('include') === 'conversations'
    && !params.has('q') && !params.has('workspaceId') && !params.has('cursor')
}

type BackgroundRequest = 'synchronization' | 'navigation' | 'catalog'

function http1BackgroundAdmission(): (signal: AbortSignal, kind: BackgroundRequest) => Promise<() => void> {
  // Draft persistence and conversation actions share the remaining HTTP/1 connections.
  let active = 0
  let readers = 0
  const waiting = { synchronization: new Set<() => void>(), navigation: new Set<() => void>(), catalog: new Set<() => void>() }
  const begin = (kind: BackgroundRequest): (() => void) => {
    active++
    if (kind !== 'synchronization') readers++
    return () => {
      active--
      if (kind !== 'synchronization') readers--
      const reader = readers < 2 ? waiting.navigation.values().next().value ?? waiting.catalog.values().next().value : undefined
      const next = waiting.synchronization.values().next().value ?? reader
      next?.()
    }
  }
  return async (signal, kind) => {
    signal.throwIfAborted()
    if (active < 3 && (kind === 'synchronization' || readers < 2)) return begin(kind)
    const admitted = Promise.withResolvers<() => void>()
    const queue = waiting[kind]
    const start = (): void => {
      queue.delete(start)
      signal.removeEventListener('abort', cancel)
      admitted.resolve(begin(kind))
    }
    const cancel = (): void => {
      queue.delete(start)
      admitted.reject(signal.reason)
    }
    queue.add(start)
    signal.addEventListener('abort', cancel, { once: true })
    return admitted.promise
  }
}

/** A changed cookie cannot transfer an existing document's retained resources to another account. */
export class BrowserIdentityChanged extends Error {
  constructor() { super('Gateway account changed; reload the Client'); this.name = 'BrowserIdentityChanged' }
}

/** Same-origin Gateway requests, socket admission, and coordinated Client teardown. */
export interface BrowserIdentityFence {
  readonly fetch: typeof fetch
  /** Confirm identity from an authenticated account response; absence is not an identity change. */
  confirm(this: void, id: number): void
  /** Fix the bootstrap runtime after decoding its Host description; absent target is an independent legacy Host. */
  setRuntimeTarget(this: void, target: ClientRuntimeTarget | undefined): void
  /** Register owned cleanup completed before document reload. */
  subscribe(this: void, cleanup: () => void | Promise<void>): () => void
  /** Wait for the first HTTP identity outcome before opening a socket and pin any known account. */
  socketUrl(this: void, url: URL, signal: AbortSignal): Promise<URL>
  /** Bind private navigation URLs to the confirmed account and optional owning Runtime. */
  privateUrl(this: void, value: string, target?: ClientRuntimeTarget): string
  /** Withdraw this document after explicit authorization loss and reload only after owned cleanup. */
  invalidate(this: void): void
  /** End this document's requests without initiating navigation. */
  dispose(this: void): void
}

/** Create the document-owned Gateway fence without changing global browser state.
 * @param fetcher - original browser fetch, before installing the returned wrapper.
 * @param origin - this document's same-origin Gateway authority.
 * @param reload - complete Client replacement after cleanup, supplied by the page owner.
 * @param search - this document's explicit Runtime selector, retained before its first handshake.
 * @returns one fence shared by every pooled runtime connection.
 */
export function createBrowserIdentityFence(fetcher: typeof fetch, origin: string, reload: () => void, search = ''): BrowserIdentityFence {
  const navigation = globalThis.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const protocol = navigation?.nextHopProtocol
  const admitBackground = protocol === 'h2' || protocol?.startsWith('h3') ? undefined : http1BackgroundAdmission()
  let principal: number | undefined
  let invalid = false
  let runtime: ClientRuntimeTarget | undefined
  const bootstrap = new URLSearchParams(search)
  let runtimeKnown = false
  const runtimeReady = Promise.withResolvers<undefined>()
  const lifetime = new AbortController()
  const ready = Promise.withResolvers<void>()
  const cleanups = new Set<() => void | Promise<void>>()
  const invalidate = (): void => {
    if (invalid) return
    invalid = true
    lifetime.abort(new BrowserIdentityChanged())
    void Promise.allSettled([...cleanups].map(async cleanup => cleanup())).then((results) => {
      for (const result of results) if (result.status === 'rejected') console.error('Client identity cleanup failed:', result.reason)
      reload()
    })
  }
  const confirm = (id: number): void => {
    if (invalid) throw new BrowserIdentityChanged()
    if (principal !== undefined && id !== principal) { invalidate(); throw new BrowserIdentityChanged() }
    principal = id
    ready.resolve()
  }
  const waitFor = async (promise: Promise<unknown>, signal: AbortSignal): Promise<void> => {
    const stopped = Promise.withResolvers<never>()
    const abort = (): void => { stopped.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) abort()
      await Promise.race([promise, stopped.promise])
      signal.throwIfAborted()
    } finally { signal.removeEventListener('abort', abort) }
  }
  const scopeSensitive = (url: URL): boolean => url.pathname === '/api' || url.pathname.startsWith('/api/')
    || ['/account/api/context', '/account/api/workbench/context', '/account/api/workbench/catalog', '/account/api/usage', '/account/api/activity'].includes(url.pathname)
  const pinRuntime = (url: URL, target?: ClientRuntimeTarget): void => {
    if (!scopeSensitive(url) || url.searchParams.has('dshRuntime') || url.searchParams.has('dshTarget')
      || url.pathname.startsWith('/api/documents') && url.searchParams.has('dshNode')) return
    const owner = target ?? runtime
    if (owner !== undefined) addressRuntimeUrl(url, owner)
    else for (const key of ['dshRuntime', 'dshTarget']) {
      const value = bootstrap.get(key)
      if (value !== null) url.searchParams.set(key, value)
    }
  }
  const fencedFetch: typeof fetch = async (input, init) => {
    const request = typeof input !== 'string' && 'url' in input ? input : undefined
    const address = typeof input === 'string' ? input : 'href' in input ? input.href : input.url
    const url = new URL(address, origin)
    const owned = url.origin === origin && (url.pathname === '/api' || url.pathname.startsWith('/api/')
      || url.pathname.startsWith('/account/api/'))
    if (!owned) return fetcher(input, init)
    lifetime.signal.throwIfAborted()
    const headers = new Headers(request?.headers)
    new Headers(init?.headers).forEach((value, key) => { headers.set(key, value) })
    const suppliedSignal = init?.signal ?? request?.signal
    const signal = suppliedSignal === undefined ? lifetime.signal
      : AbortSignal.any([lifetime.signal, suppliedSignal])
    if (url.pathname !== '/api/host.describe' && scopeSensitive(url) && !url.searchParams.has('dshTarget')
      && !url.searchParams.has('dshRuntime') && !url.searchParams.has('dshNode')) {
      await waitFor(runtimeReady.promise, signal)
    }
    const originalUrl = url.toString()
    pinRuntime(url)
    const target = url.toString() === originalUrl ? input : request === undefined ? url : new Request(url, request)
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const scoped = url.searchParams.has('dshRuntime')
    const limited = scoped && admitBackground !== undefined
    const navigation = limited && navigationRead(url, method)
    const catalog = method === 'POST' && (ADVISORY_READS.has(url.pathname) || limited && HTTP1_ADVISORY_READS.has(url.pathname))
    const advisory = scoped && (navigation || catalog) && init?.priority !== 'high'
    const synchronization = limited && method === 'POST' && HTTP1_SYNCHRONIZATION.has(url.pathname) && init?.priority !== 'high'
    const foreground = limited && method === 'POST' && HTTP1_CONVERSATION_ACTIONS.has(url.pathname)
    const priority = advisory ? 'low' : foreground && init?.priority === undefined ? 'high' : undefined
    const release = (advisory || synchronization) && admitBackground !== undefined
      ? await admitBackground(signal, synchronization ? 'synchronization' : navigation ? 'navigation' : 'catalog') : undefined
    try {
      signal.throwIfAborted()
      if (principal !== undefined) headers.set(EXPECTED_ID, String(principal))
      let response: Response
      try {
        response = await fetcher(target, { ...init, ...(priority === undefined ? {} : { priority }), headers, signal })
      } catch (cause: unknown) {
        signal.throwIfAborted()
        throw new ApiTransportError(0, url.pathname, { cause })
      }
      lifetime.signal.throwIfAborted()
      const identity = response.headers.get(RESPONSE_ID)
      if (identity !== null) {
        const id = Number(identity)
        if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== identity) { invalidate(); throw new BrowserIdentityChanged() }
        confirm(id)
      } else if (response.status === 401 && principal !== undefined) {
        invalidate(); throw new BrowserIdentityChanged()
      }
      ready.resolve()
      return response
    } finally { release?.() }
  }
  return {
    fetch: fencedFetch,
    confirm,
    invalidate,
    setRuntimeTarget: (target) => {
      lifetime.signal.throwIfAborted()
      const selected = target === undefined ? undefined : runtimeTargetKey(target)
      if (runtimeKnown && selected !== (runtime === undefined ? undefined : runtimeTargetKey(runtime))
        || bootstrap.has('dshRuntime') && target?.runtimeId !== bootstrap.get('dshRuntime')) {
        invalidate(); throw new BrowserIdentityChanged()
      }
      runtimeKnown = true
      runtime = target
      runtimeReady.resolve(undefined)
    },
    subscribe: (cleanup) => { cleanups.add(cleanup); return () => { cleanups.delete(cleanup) } },
    socketUrl: async (url, signal) => {
      lifetime.signal.throwIfAborted()
      const combined = AbortSignal.any([signal, lifetime.signal])
      await waitFor(ready.promise, combined)
      if (!url.searchParams.has('dshTarget')) await waitFor(runtimeReady.promise, combined)
      const result = new URL(url)
      pinRuntime(result)
      if (principal !== undefined) result.searchParams.set('dshPrincipal', String(principal))
      return result
    },
    privateUrl: (value, target) => {
      lifetime.signal.throwIfAborted()
      const url = new URL(value, origin)
      if (url.origin !== origin || (url.pathname !== '/api' && !url.pathname.startsWith('/api/')
        && !url.pathname.startsWith('/account/api/')) || principal === undefined) return value
      pinRuntime(url, target)
      url.searchParams.set('dshPrincipal', String(principal))
      return value.startsWith('/') && !value.startsWith('//') ? `${url.pathname}${url.search}${url.hash}` : url.toString()
    },
    dispose: () => { invalid = true; lifetime.abort(new Error('Client Connection disposed')); cleanups.clear() },
  }
}
