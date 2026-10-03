// @vitest-environment jsdom
// Client apply wiring under the terminal register form: ctx.layout provided,
// ONE register() call declares the three child slots + seats the store factory
// + wires the panel actions through the inject hook; teardown cascades
// (service unprovided + declarations gone + registration cleared).

import { Context } from '@deepseek-ai/cordis'
import { stubSettingsScope, stubDeveloperTools } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as themeApply, inject as themeInject, ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import { apply, inject, LayoutController } from '@deepseek-ai/dsh-client-ui-layout/client'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-layout'

beforeEach(() => {
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((node) => { node.remove() })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function bench() {
  const ctx = new Context()
  const slotsFiber = ctx.plugin(SlotRegistry)
  // Theme registers its Appearance settings row and requires the connection
  // seam for persistence; model this bench as a remote, memory-only browser.
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('shortcuts', { register: vi.fn(() => () => {}) } as never)
  // ui-theme's Appearance row binds a durable scope through these two.
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope, developerTools: stubDeveloperTools().preference } as never)
  // ui-layout watches ctx.sessions.list for selection changes that return the
  // center to the Conversation; a static empty list satisfies the wiring.
  ctx.provide('sessions', {
    list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} },
  } as never)
  await ctx.plugin({ inject: themeInject, apply: themeApply }).await()
  await slotsFiber.await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

describe('ui-layout client apply', () => {
  it('declares its service dependencies', () => {
    expect(inject).toEqual(['slots', 'theme', 'locale', 'shortcuts', 'sessions'])
  })

  it('provides ctx.layout and registers AppFrame with the shell child declarations', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.get('layout')).toBeInstanceOf(LayoutController)
    // The one register() call occupied 'root'…
    expect(slots.entries('root')).toHaveLength(1)
    // …and declared the shell children in the ledger.
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('main')).toEqual({ kind: 'keyed', scope: 'root' })
    expect(slots.spec('rightbar')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('shell.mobile.header.actions')).toEqual({ kind: 'list', scope: 'session' })
  })

  it('publishes the frame\'s measured viewport width from the root store', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const instance = (slots.entries('root')[0]!.store as ReturnType<typeof createLayoutStore>).create()
    const layout = ctx.get('layout') as LayoutController
    const seen: number[] = []
    const unsubscribe = layout.viewportWidth.subscribe(() => { seen.push(layout.viewportWidth.getSnapshot()) })
    try {
      instance.actions.setViewportWidth(700)
      expect(layout.viewportWidth.getSnapshot()).toBe(700)
      expect(seen).toContain(700)
    } finally {
      unsubscribe()
      await fiber.dispose()
    }
  })

  it('injects only the dismissRightbar hook while the service drives the shared store instance', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = slots.entries('root')[0]!
    const injected = (entry.inject as () => object)()
    expect(injected).toEqual({ dismissRightbar: expect.any(Function) as unknown })
    const handle = entry.store as ReturnType<typeof createLayoutStore>
    const instance = handle.create()
    expect(handle.create()).toBe(instance)
    const layout = ctx.get('layout') as LayoutController
    instance.actions.setViewportWidth(1440)
    const before = instance.getSnapshot().sidebar
    layout.toggleSidebar()
    expect(instance.getSnapshot().sidebar).not.toBe(before)
    await fiber.dispose()
  })

  it('theme presenter applies the initial snapshot, follows theme/change, and unwinds on dispose', async () => {
    const { ctx } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // Initial getter application: jsdom has no matchMedia, system resolves light.
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    const themeColorMeta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    expect(themeColorMeta).not.toBeNull()
    const theme = ctx.get('theme') as ThemeRuntime
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    expect(document.head.querySelector('meta[name="theme-color"]')).toBe(themeColorMeta)
    await fiber.dispose()
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    expect(themeColorMeta?.isConnected).toBe(false)
    // Listener is off: further theme changes no longer reach the document.
    theme.setTheme('light')
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
  })

  it('visual viewport variable tracks resize, folds pinch scale out, and unwinds on dispose', async () => {
    const listeners = new Set<() => void>()
    const viewportStub = {
      height: 800,
      scale: 1,
      addEventListener: (_type: string, fn: () => void) => { listeners.add(fn) },
      removeEventListener: (_type: string, fn: () => void) => { listeners.delete(fn) },
    }
    vi.stubGlobal('visualViewport', viewportStub)
    const { ctx } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const readVar = () => document.documentElement.style.getPropertyValue('--dsw-viewport-height')
    expect(readVar()).toBe('800px')
    viewportStub.height = 500
    listeners.forEach((fn) => { fn() })
    expect(readVar()).toBe('500px')
    // Pinch zoom shrinks the visual height while scale rises; the product
    // height * scale keeps tracking the layout viewport.
    viewportStub.height = 250
    viewportStub.scale = 2
    listeners.forEach((fn) => { fn() })
    expect(readVar()).toBe('500px')
    await fiber.dispose()
    expect(readVar()).toBe('')
    expect(listeners.size).toBe(0)
  })

  it('teardown unwinds the service, the root registration, and the child declarations', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(ctx.get('layout')).toBeUndefined()
    expect(slots.entries('root')).toHaveLength(0)
    expect(slots.spec('sidebar')).toBeUndefined()
    expect(slots.spec('shell.mobile.header.actions')).toBeUndefined()
    // The built-in root declaration survives entry teardown (runtime-owned).
    expect(slots.spec('root')).toEqual({ kind: 'single', scope: 'root' })
  })
})

describe('node half', () => {
  it('node apply is an intentional no-op (loader-managed lifecycle only)', () => {
    nodeApply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })
})
