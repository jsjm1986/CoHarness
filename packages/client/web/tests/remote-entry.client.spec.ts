// @vitest-environment jsdom
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadRemoteEntry,
  RemoteEntryAccountChanged,
  remoteEntrySelection,
  remoteEntryUrl,
  type RemoteEntrySelection,
} from '../src/remote-entry.ts'

const ENTRY: RemoteEntrySelection = {
  principalId: 7,
  runtimeId: '10000000-0000-4000-8000-000000000002',
  nodeId: '20000000-0000-4000-8000-000000000002',
  nodeName: 'Compute computer',
  scope: 'personal',
  language: 'en',
}

const IDENTITY_ROW: IndexInjection = {
  kind: 'global',
  name: '__DSH_DOCUMENT_IDENTITY__',
  value: { version: 1, principalId: 7, runtimeTarget: { kind: 'personal', runtimeId: ENTRY.runtimeId } },
}

const BOOTSTRAP_SRC = 'plugins/combo.js??@deepseek-ai/dsh-client-modules/client.js&rev=0123456789ab'
const APPLICATION_SRC = 'plugins/combo.js??conversation/client.js,sidebar/client.js&rev=fedcba987654'
const PRELOAD_SRC = `${APPLICATION_SRC}&dshAssetPreload=1`
const QUEUE_ROW = { kind: 'script', placement: 'head', text: 'window.__ModuleLoader__ = { mode: "queue", pendingQueue: [] }' } as const
const APPLICATION_BATCH = { phase: 'application', url: APPLICATION_SRC, entries: ['conversation', 'sidebar'] }
const GRAPH_ROW = { kind: 'global', name: '__DSH_BOOT__', value: { batches: [APPLICATION_BATCH] } } as const

function interceptScripts(onScript: (node: HTMLScriptElement, src: string) => void): void {
  const append = document.head.append.bind(document.head)
  vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
    append(...nodes)
    for (const node of nodes) {
      if (!(node instanceof HTMLScriptElement)) continue
      const src = node.getAttribute('src')
      if (src !== null) onScript(node, src)
      else if (node.textContent === QUEUE_ROW.text) {
        ;(globalThis as Record<string, unknown>).__ModuleLoader__ = { mode: 'queue', pendingQueue: [] }
      }
    }
  })
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-dsh-principal-id': String(ENTRY.principalId), ...headers },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  delete (globalThis as Record<string, unknown>).__ModuleLoader__
  delete (globalThis as Record<string, unknown>).__DSH_DOCUMENT_IDENTITY__
  delete (globalThis as Record<string, unknown>).__DSH_BOOT__
})

describe('remoteEntrySelection and remoteEntryUrl', () => {
  it('returns undefined when no remote marker exists and validates well-formed markers', () => {
    expect(remoteEntrySelection()).toBeUndefined()
    const marker = document.createElement('script')
    marker.id = 'dsh-runtime-bootstrap'
    marker.type = 'application/json'
    marker.textContent = JSON.stringify({ version: 1, ...ENTRY })
    document.head.append(marker)
    expect(remoteEntrySelection()).toEqual(ENTRY)

    marker.textContent = JSON.stringify({ version: 2 })
    expect(() => remoteEntrySelection()).toThrow('Invalid remote entry selection')
  })

  it('builds structured and full-document continuation URLs', () => {
    const structured = remoteEntryUrl(ENTRY, '1')
    expect(structured.searchParams.get('dshBootstrap')).toBe('1')
    expect(structured.searchParams.get('dshPrincipal')).toBeNull()
    const full = remoteEntryUrl(ENTRY, 'full')
    expect(full.searchParams.get('dshBootstrap')).toBe('full')
    expect(full.searchParams.get('dshPrincipal')).toBe('7')
  })
})

describe('loadRemoteEntry', () => {
  it('starts bootstrap first and overlaps one approved application batch even when bootstrap retries', async () => {
    const second = 'plugins/combo.js??a/client.js,b/client.js&rev=0123456789ab'
    const wrongPhase = 'plugins/combo.js??x/client.js,y/client.js&rev=0123456789ab'
    const invalid = [
      `https://foreign.example/${APPLICATION_SRC}`,
      APPLICATION_SRC.split('&')[0]!,
      'plugins/combo.js??a/client.js&rev=0123456789ab',
      'plugins/combo.js??a/client.js.map,b/client.js.map&rev=0123456789ab',
    ]
    const undeclared = 'plugins/combo.js??c/client.js,d/client.js&rev=0123456789ab'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      version: 1,
      kind: 'injections',
      rows: [
        IDENTITY_ROW, QUEUE_ROW,
        ...[undeclared, wrongPhase, ...invalid, APPLICATION_SRC, second].map(src => ({ kind: 'script-preload', src })),
        { kind: 'script-src', placement: 'head', src: BOOTSTRAP_SRC },
        { kind: 'style', text: 'body {}' },
        { kind: 'html', placement: 'body', html: '<div data-marker></div>' },
        { kind: 'global', name: '__DSH_BOOT__', value: { batches: [
          ...[...invalid, second].map(url => ({ ...APPLICATION_BATCH, url })),
          { ...APPLICATION_BATCH, phase: 'bootstrap', url: wrongPhase },
          APPLICATION_BATCH,
        ] } },
      ],
    }))
    const appended: string[] = []
    const started = Promise.withResolvers<HTMLScriptElement>()
    const finishedBootstrap = Promise.withResolvers<undefined>()
    interceptScripts((node, src) => {
      appended.push(src)
      if (src === PRELOAD_SRC) started.resolve(node)
      if (src === BOOTSTRAP_SRC && appended.length === 3) {
        node.onload?.(new Event('load'))
        finishedBootstrap.resolve(undefined)
      }
    })

    const loading = loadRemoteEntry(ENTRY, new AbortController().signal)
    const preload = await started.promise
    const bootstrap = document.head.querySelector<HTMLScriptElement>(`script[src="${BOOTSTRAP_SRC}"]`)!
    expect(appended).toEqual([BOOTSTRAP_SRC, PRELOAD_SRC])
    expect(preload.fetchPriority).toBe('low')
    expect(bootstrap.fetchPriority).toBe('high')
    bootstrap.onerror?.(new Event('error'))
    await finishedBootstrap.promise
    preload.onload?.(new Event('load'))
    await expect(loading).resolves.toEqual({ kind: 'injections', preloadedBundles: new Map([[APPLICATION_SRC, 'executed']]) })
    expect(appended).toEqual([BOOTSTRAP_SRC, PRELOAD_SRC, BOOTSTRAP_SRC])
    expect(preload.isConnected).toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('x-dsh-bootstrap-preload')).toBe('1')
    const bootMarks = performance.getEntriesByType('mark').map(mark => mark.name).filter(name => name.startsWith('dsh:boot:'))
    expect(bootMarks.slice(-2)).toEqual(['dsh:boot:bootstrap-json-ready', 'dsh:boot:bootstrap-scripts-ready'])
  })

  it('reports a speculative transport failure to the loader under the original batch URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      version: 1,
      kind: 'injections',
      rows: [
        IDENTITY_ROW, QUEUE_ROW, GRAPH_ROW,
        { kind: 'script-preload', src: APPLICATION_SRC },
        { kind: 'script-src', placement: 'head', src: BOOTSTRAP_SRC },
      ],
    }))
    interceptScripts((node, src) => {
      if (src === PRELOAD_SRC) node.onerror?.(new Event('error'))
      else node.onload?.(new Event('load'))
    })

    await expect(loadRemoteEntry(ENTRY, new AbortController().signal))
      .resolves.toEqual({ kind: 'injections', preloadedBundles: new Map([[APPLICATION_SRC, 'load-failed']]) })
    expect(document.head.querySelector(`script[src="${PRELOAD_SRC}"]`)).toBeNull()
  })

  it.each(['bootstrap', 'document'] as const)('removes the speculative script when the %s fails', async (failure) => {
    const unversioned = 'plugins/non-combo-bootstrap.js'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      version: 1,
      kind: 'injections',
      rows: [
        IDENTITY_ROW, QUEUE_ROW, GRAPH_ROW,
        { kind: 'script-preload', src: APPLICATION_SRC },
        { kind: 'script-src', placement: 'head', src: unversioned },
      ],
    }))
    const started = Promise.withResolvers<HTMLScriptElement>()
    interceptScripts((node, src) => { if (src === PRELOAD_SRC) started.resolve(node) })

    const controller = new AbortController()
    const loading = loadRemoteEntry(ENTRY, controller.signal)
    const preload = await started.promise
    if (failure === 'bootstrap') document.head.querySelector<HTMLScriptElement>(`script[src="${unversioned}"]`)!.onerror?.(new Event('error'))
    else controller.abort(new Error('page closed'))
    await expect(loading).rejects.toThrow(failure === 'bootstrap' ? 'A Runtime bootstrap script could not load' : 'page closed')
    expect(preload.isConnected).toBe(false)
  })

  it('handles full-index, project scope, account changes, malformed payloads, and aborts', async () => {
    const projectEntry: RemoteEntrySelection = { ...ENTRY, scope: 'project:42' }
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'x-dsh-principal-id': '7' } }))
      .mockResolvedValueOnce(jsonResponse({ version: 1, kind: 'full-index' }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 500, headers: { 'x-dsh-principal-id': '7' } }))
      .mockResolvedValueOnce(new Response('plain', { status: 200, headers: { 'content-type': 'text/plain', 'x-dsh-principal-id': '7' } }))
      .mockResolvedValueOnce(jsonResponse({ version: 2 }))
      .mockResolvedValueOnce(jsonResponse({ version: 1, kind: 'injections', rows: [null] }))
      .mockResolvedValueOnce(jsonResponse({ version: 1, kind: 'injections', rows: [{ kind: 'unknown' }] }))
      .mockResolvedValueOnce(jsonResponse({
        version: 1,
        kind: 'injections',
        rows: [{ kind: 'global', name: '__DSH_DOCUMENT_IDENTITY__', value: { version: 2 } }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        version: 1,
        kind: 'injections',
        rows: [{ kind: 'global', name: '__DSH_DOCUMENT_IDENTITY__', value: { version: 1, principalId: 7, runtimeTarget: { kind: 'project', projectId: 99, runtimeId: ENTRY.runtimeId } } }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        version: 1,
        kind: 'injections',
        rows: [
          { kind: 'global', name: '__DSH_DOCUMENT_IDENTITY__', value: { version: 1, principalId: 7, runtimeTarget: { kind: 'project', projectId: 42, runtimeId: ENTRY.runtimeId } } },
          { kind: 'script-src', placement: 'head', src: BOOTSTRAP_SRC },
        ],
      }))

    const signal = new AbortController().signal
    await expect(loadRemoteEntry(ENTRY, signal)).resolves.toEqual({ kind: 'full-index' })
    await expect(loadRemoteEntry(ENTRY, signal)).resolves.toEqual({ kind: 'full-index' })
    await expect(loadRemoteEntry(ENTRY, signal)).rejects.toBeInstanceOf(RemoteEntryAccountChanged)
    await expect(loadRemoteEntry(ENTRY, signal)).rejects.toThrow('Runtime bootstrap returned HTTP 500')
    await expect(loadRemoteEntry(ENTRY, signal)).rejects.toThrow('Runtime bootstrap returned an unsupported document')
    await expect(loadRemoteEntry(ENTRY, signal)).rejects.toThrow('Invalid Runtime bootstrap document')
    await expect(loadRemoteEntry(ENTRY, signal)).rejects.toThrow('Invalid Runtime bootstrap document')
    await expect(loadRemoteEntry(ENTRY, signal)).rejects.toThrow('Invalid Runtime bootstrap document')
    await expect(loadRemoteEntry(ENTRY, signal)).rejects.toThrow('Runtime bootstrap returned a different document identity')
    await expect(loadRemoteEntry(projectEntry, signal)).rejects.toThrow('Runtime bootstrap returned a different document identity')

    const aborted = new AbortController()
    const originalAppend = document.head.append.bind(document.head)
    vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
      originalAppend(...nodes)
      aborted.abort('custom-stop')
    })
    await expect(loadRemoteEntry(projectEntry, aborted.signal)).rejects.toBe('custom-stop')
  })

  it('rejects immediately if aborted while appending a script with an Error reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      version: 1,
      kind: 'injections',
      rows: [
        IDENTITY_ROW,
        { kind: 'script', placement: 'head', text: 'window.__ModuleLoader__ = { mode: "queue" }' },
        { kind: 'script-src', placement: 'head', src: BOOTSTRAP_SRC },
      ],
    }))
    const controller = new AbortController()
    const originalAppend = document.head.append.bind(document.head)
    vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
      originalAppend(...nodes)
      if (nodes[0] instanceof HTMLScriptElement && nodes[0].getAttribute('src') === BOOTSTRAP_SRC) {
        controller.abort(new Error('page closed'))
      }
    })
    await expect(loadRemoteEntry(ENTRY, controller.signal)).rejects.toThrow('page closed')
  })

  it('handles body-cancel rejection on account switch and an already-aborted signal before script append', async () => {
    const cancel = vi.fn(() => Promise.reject(new Error('stream locked')))
    const failingCancelResponse = new Response(new ReadableStream({ cancel }), { status: 401 })
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(failingCancelResponse)
      .mockResolvedValueOnce(jsonResponse({
        version: 1,
        kind: 'injections',
        rows: [
          IDENTITY_ROW,
          { kind: 'script', placement: 'head', text: 'void 0' },
          { kind: 'script-src', placement: 'head', src: BOOTSTRAP_SRC },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        version: 1,
        kind: 'injections',
        rows: [
          IDENTITY_ROW,
          { kind: 'script-src', placement: 'head', src: BOOTSTRAP_SRC },
        ],
      }))

    await expect(loadRemoteEntry(ENTRY, new AbortController().signal)).rejects.toBeInstanceOf(RemoteEntryAccountChanged)
    expect(cancel).toHaveBeenCalledOnce()

    const controller = new AbortController()
    const originalAppend = document.head.append.bind(document.head)
    const appendSpy = vi.spyOn(document.head, 'append').mockImplementation((...nodes) => {
      originalAppend(...nodes)
      if (nodes[0] instanceof HTMLScriptElement && nodes[0].getAttribute('src') === null) {
        controller.abort(new Error('aborted during inline script'))
      }
    })
    await expect(loadRemoteEntry(ENTRY, controller.signal)).rejects.toThrow('aborted during inline script')

    appendSpy.mockImplementation((...nodes) => {
      originalAppend(...nodes)
      const script = nodes[0]
      if (script instanceof HTMLScriptElement && script.getAttribute('src') === BOOTSTRAP_SRC) {
        queueMicrotask(() => { script.onload?.(new Event('load')) })
      }
    })
    await expect(loadRemoteEntry(ENTRY, new AbortController().signal)).resolves.toEqual({ kind: 'injections', preloadedBundles: new Map() })
  })
})
