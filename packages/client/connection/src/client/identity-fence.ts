/** One browser document's authenticated Gateway identity and request lifetime. */
import type { ClientRuntimeTarget } from '@deepseek-ai/dsh-host-apiproxy/api'

const RESPONSE_ID = 'x-dsh-principal-id'
const EXPECTED_ID = 'x-dsh-expected-principal-id'

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
  /** Bind application-generated private navigation URLs to the confirmed account. */
  privateUrl(this: void, value: string): string
  /** Withdraw this document after explicit authorization loss and reload only after owned cleanup. */
  invalidate(this: void): void
  /** End this document's requests without initiating navigation. */
  dispose(this: void): void
}

/** Create the document-owned Gateway fence without changing global browser state.
 * @param fetcher - original browser fetch, before installing the returned wrapper.
 * @param origin - this document's same-origin Gateway authority.
 * @param reload - complete Client replacement after cleanup, supplied by the page owner.
 * @returns one fence shared by every pooled runtime connection.
 */
export function createBrowserIdentityFence(fetcher: typeof fetch, origin: string, reload: () => void): BrowserIdentityFence {
  let principal: number | undefined
  let invalid = false
  let runtime: string | undefined
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
    || ['/account/api/context', '/account/api/workbench/catalog', '/account/api/usage'].includes(url.pathname)
  const pinRuntime = (url: URL): void => {
    if (runtime !== undefined && !url.searchParams.has('dshTarget') && scopeSensitive(url)) url.searchParams.set('dshTarget', runtime)
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
    if (url.pathname !== '/api/host.describe' && scopeSensitive(url) && !url.searchParams.has('dshTarget')) {
      await waitFor(runtimeReady.promise, signal)
    }
    if (principal !== undefined) headers.set(EXPECTED_ID, String(principal))
    const originalUrl = url.toString()
    pinRuntime(url)
    const target = url.toString() === originalUrl ? input : request === undefined ? url : new Request(url, request)
    const response = await fetcher(target, { ...init, headers, signal })
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
  }
  return {
    fetch: fencedFetch,
    confirm,
    invalidate,
    setRuntimeTarget: (target) => {
      lifetime.signal.throwIfAborted()
      const selected = target === undefined ? undefined : target.kind === 'personal' ? 'personal' : `project:${String(target.projectId)}`
      if (runtimeKnown && selected !== runtime) { invalidate(); throw new BrowserIdentityChanged() }
      runtimeKnown = true
      runtime = selected
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
    privateUrl: (value) => {
      lifetime.signal.throwIfAborted()
      const url = new URL(value, origin)
      if (url.origin !== origin || (url.pathname !== '/api' && !url.pathname.startsWith('/api/')
        && !url.pathname.startsWith('/account/api/')) || principal === undefined) return value
      pinRuntime(url)
      url.searchParams.set('dshPrincipal', String(principal))
      return value.startsWith('/') && !value.startsWith('//') ? `${url.pathname}${url.search}${url.hash}` : url.toString()
    },
    dispose: () => { invalid = true; lifetime.abort(new Error('Client Connection disposed')); cleanups.clear() },
  }
}
