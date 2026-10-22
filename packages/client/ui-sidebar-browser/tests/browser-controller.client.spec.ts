// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { BrowserController, createBrowserControllers } from '../src/client/browser/BrowserController.ts'
import type { BrowserTabState } from '../src/client/contract/navigation.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'

const TAB = 'tab' as TabId
const TAB2 = 'tab2' as TabId
const APP = 'https://dsh.example'
const lifetimes = new Set<AbortController>()

function lifetime(): AbortController {
  const controller = new AbortController()
  lifetimes.add(controller)
  return controller
}

/** Committed layout membership the controllers consult on occurrence abort. */
function openTabs(initial: readonly TabId[] = [TAB]) {
  const open = new Set<TabId>(initial)
  return { open, isTabOpen: (tabId: TabId): boolean => open.has(tabId) }
}

/** A persisted checkpoint carries history and a zero-revision pending request. */
const SAVED: BrowserTabState = {
  entries: [{ kind: 'https', url: 'https://saved.example/', title: 'saved.example' }],
  index: 0,
  request: { target: { kind: 'https', url: 'https://saved.example/', title: 'saved.example' }, revision: 0 },
  navigation: { status: 'empty' },
  failure: undefined,
}

afterEach(() => {
  for (const controller of lifetimes) controller.abort()
  lifetimes.clear()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('BrowserController', () => {
  it('ignores navigation commands after its tab occurrence ends', () => {
    const store = createBrowserStore().create('browser-controller-ended-test')
    const tabLifetime = lifetime()
    const controller = new BrowserController({
      tabId: TAB, signal: tabLifetime.signal, applicationOrigin: APP, actions: store.actions,
    })
    tabLifetime.abort()

    controller.loadUrl('https://ignored.example/')
    controller.goBack()
    controller.goForward()
    controller.reload()
    controller.start('https://ignored.example/')
    controller.frame.reportLoaded(1)
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
  })

  it('owns the four navigation commands and frame load state', () => {
    const { open, isTabOpen } = openTabs()
    const store = createBrowserStore().create('browser-controller-test')
    const face = createBrowserControllers(store.actions, isTabOpen)
    const tabLifetime = lifetime()
    face.mount(TAB, tabLifetime.signal, APP)
    const frame = face.keyedHooks.browserFrame(TAB)!
    face.mount(TAB, tabLifetime.signal, APP)
    expect(face.keyedHooks.browserFrame(TAB)).toBe(frame)
    face.goBack(TAB)
    face.goForward(TAB)
    face.reload(TAB)

    face.loadUrl(TAB, 'https://example.test/one')
    const first = frame.getSnapshot().document!
    expect(first.src).toBe('https://example.test/one')
    face.reportLoaded(TAB, first.revision - 1)
    face.reportLoaded(TAB, first.revision)
    expect(store.getSnapshot().byTab[TAB]?.navigation.status).toBe('known')
    face.reportLoaded(TAB, first.revision)
    expect(store.getSnapshot().byTab[TAB]?.navigation.status).toBe('unknown')
    face.goBack(TAB)
    face.goForward(TAB)
    expect(store.getSnapshot().byTab[TAB]?.navigation.status).toBe('unknown')

    face.loadUrl(TAB, 'https://example.test/two')
    face.goBack(TAB)
    expect(frame.getSnapshot().document?.target.url).toBe('https://example.test/one')
    face.goForward(TAB)
    expect(frame.getSnapshot().document?.target.url).toBe('https://example.test/two')
    const beforeReload = store.getSnapshot().byTab[TAB]!.request!.revision
    face.reload(TAB)
    expect(store.getSnapshot().byTab[TAB]?.request?.revision).toBe(beforeReload + 1)
    face.loadUrl(TAB, 'https://example.test/two')
    expect(store.getSnapshot().byTab[TAB]?.request?.revision).toBe(beforeReload + 2)

    open.delete(TAB)
    tabLifetime.abort()
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
    face.reportLoaded(TAB, first.revision)
    face.loadUrl(TAB, 'https://ignored.example/')
    face.goBack(TAB)
    face.goForward(TAB)
    face.reload(TAB)
  })

  it('does not let an old occurrence delete a replacement controller', () => {
    const { isTabOpen } = openTabs()
    const store = createBrowserStore().create('browser-controller-replacement-test')
    const face = createBrowserControllers(store.actions, isTabOpen)
    const first = lifetime()
    const second = lifetime()
    face.mount(TAB, first.signal, APP)
    const original = face.keyedHooks.browserFrame(TAB)
    face.mount(TAB, second.signal, APP)
    const replacement = face.keyedHooks.browserFrame(TAB)
    expect(replacement).not.toBe(original)
    first.abort()
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
    face.loadUrl(TAB, 'https://example.test/')
    expect(store.getSnapshot().byTab[TAB]).toBeDefined()
    face.mount(TAB, second.signal, APP)
    expect(face.keyedHooks.browserFrame(TAB)).toBe(replacement)
  })

  it('loads loopback under sandbox and reloads it across sandbox changes', () => {
    const { isTabOpen } = openTabs()
    const store = createBrowserStore().create('browser-controller-loopback-test')
    const face = createBrowserControllers(store.actions, isTabOpen)
    const tabLifetime = lifetime()
    face.mount(TAB, tabLifetime.signal, APP)
    const frame = face.keyedHooks.browserFrame(TAB)!

    face.loadUrl(TAB, 'http://localhost:5173/app')
    expect(frame.getSnapshot()).toMatchObject({
      sandboxed: true,
      document: { src: 'http://localhost:5173/app' },
    })
    const beforeToggle = store.getSnapshot().byTab[TAB]!.request!.revision

    face.toggleSandbox(TAB)
    expect(frame.getSnapshot().sandboxed).toBe(false)
    expect(frame.getSnapshot().document?.src).toBe('http://localhost:5173/app')
    expect(store.getSnapshot().byTab[TAB]?.request?.revision).toBe(beforeToggle + 1)

    face.toggleSandbox(TAB)
    expect(frame.getSnapshot()).toMatchObject({
      sandboxed: true,
      document: { src: 'http://localhost:5173/app' },
    })
    expect(store.getSnapshot().byTab[TAB]?.request?.revision).toBe(beforeToggle + 2)
  })

  it('loads public HTTP without changing the sandbox policy', () => {
    const { isTabOpen } = openTabs()
    const store = createBrowserStore().create('browser-controller-http-test')
    const face = createBrowserControllers(store.actions, isTabOpen)
    const tabLifetime = lifetime()
    face.mount(TAB, tabLifetime.signal, APP)

    face.loadUrl(TAB, 'http://example.test/path')
    expect(face.keyedHooks.browserFrame(TAB)?.getSnapshot()).toMatchObject({
      sandboxed: true,
      document: { src: 'http://example.test/path' },
    })
  })

  it('keeps saved navigation when teardown aborts a still-open record', () => {
    const { isTabOpen } = openTabs()
    const store = createBrowserStore().create('browser-controller-teardown-test')
    const face = createBrowserControllers(store.actions, isTabOpen)
    const tabLifetime = lifetime()
    face.mount(TAB, tabLifetime.signal, APP)
    face.loadUrl(TAB, 'https://example.test/one')

    // Domain disposal aborts every occurrence while its layout records remain open.
    tabLifetime.abort()
    expect(face.keyedHooks.browserFrame(TAB)).toBeUndefined()
    expect(store.getSnapshot().byTab[TAB]?.entries.at(-1)?.url).toBe('https://example.test/one')
  })

  it('forgets saved navigation when its record is removed', () => {
    const { open, isTabOpen } = openTabs()
    const store = createBrowserStore().create('browser-controller-removal-test')
    const face = createBrowserControllers(store.actions, isTabOpen)
    const tabLifetime = lifetime()
    face.mount(TAB, tabLifetime.signal, APP)
    face.loadUrl(TAB, 'https://example.test/one')

    open.delete(TAB)
    tabLifetime.abort()
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
  })

  it('consumes a typed-open address once and never auto-loads a saved entry', () => {
    const { isTabOpen } = openTabs([TAB, TAB2])
    const store = createBrowserStore().create('browser-controller-start-test')
    const face = createBrowserControllers(store.actions, isTabOpen)
    const tabLifetime = lifetime()
    face.mount(TAB, tabLifetime.signal, APP, SAVED)
    const frame = face.keyedHooks.browserFrame(TAB)!
    // A checkpoint alone is only offered for restore; nothing loads it.
    expect(frame.getSnapshot().document).toBeUndefined()
    // The occurrence already consumed its start; a later offer is ignored.
    face.mount(TAB, tabLifetime.signal, APP, SAVED, 'https://other.example/')
    expect(frame.getSnapshot().document).toBeUndefined()

    const second = lifetime()
    face.mount(TAB2, second.signal, APP, SAVED, 'https://typed.example/')
    expect(face.keyedHooks.browserFrame(TAB2)?.getSnapshot().document?.target.url).toBe('https://typed.example/')
    face.mount(TAB2, second.signal, APP, SAVED, 'https://again.example/')
    expect(face.keyedHooks.browserFrame(TAB2)?.getSnapshot().document?.target.url).toBe('https://typed.example/')

    const deadTab = 'dead' as TabId
    const dead = lifetime()
    dead.abort()
    face.mount(deadTab, dead.signal, APP, SAVED, 'https://dead.example/')
    expect(face.keyedHooks.browserFrame(deadTab)).toBeUndefined()
  })
})
