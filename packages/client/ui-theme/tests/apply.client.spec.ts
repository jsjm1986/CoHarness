/** ui-theme apply wiring: service provision, settings dictionaries riding the
 * locale service, declaration-aware Appearance and font-settings row
 * registration, snapshot projection into the row stores, desktop font-size
 * shortcuts, and HMR collapse recovery. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, SETTINGS_NS, ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { AppearanceRowInjected, FontSettingsInjected, ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { THEME_SETTINGS_NAMESPACE, ThemeSettingsSchema, type ThemeSettings } from '../src/theme-settings.ts'
import { AppearanceRow } from '../src/client/AppearanceRow.tsx'
import { FontSettingsGroup } from '../src/client/FontSettingsGroup.tsx'
import type { createAppearanceRowStore, createFontRowStore } from '../src/client/settings-store.ts'
import type { Shortcuts, ShortcutContext, ShortcutFixedInput, ShortcutGesture, ShortcutPlatform } from '@deepseek-ai/dsh-client-shortcuts/client'
import { bindingKey, normalizeBinding, presentBinding } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { ShortcutRegistry } from '../../shortcuts/src/client/registry.ts'

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); bench stages zh explicitly on the locale instead.

const SLOT = 'settings.general.item'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function bench(isLoopback = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const section: Record<string, unknown> = {
    preference: 'system', fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
    textFontFamily: '', codeFontFamily: '', terminalFontFamily: '',
  }
  const namespace = () => ({
    ns: THEME_SETTINGS_NAMESPACE,
    schema: ThemeSettingsSchema.toJSON(),
    value: { ...section },
    applies: 'live' as const,
    secrets: [],
    revision: 0,
  })
  const describe = vi.fn(() => Promise.resolve({
    rpcId: 'theme-describe' as never,
    result: {
      ok: true as const,
      value: { writable: true, hasDocument: true, namespaces: [namespace()] },
    },
  }))
  const mutate = vi.fn((request: { ops: { path: string[]; value: unknown }[] }) => {
    for (const op of request.ops) section[op.path[0]!] = op.value
    return Promise.resolve({
      rpcId: 'theme-mutate' as never,
      result: { ok: true as const, value: namespace() },
    })
  })
  ctx.provide('connection', { api: { settings: { describe, mutate } }, isLoopback } as never)
  // The settings transport and the forwarded-event port the plugin injects.
  new TestRemote(ctx)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, locale, describe, mutate,
    setHostSection: (next: Record<string, unknown>) => { Object.assign(section, next) },
    setHostPreference: (next: string) => { section.preference = next },
  }
}

/** Stand in for the settings shell: declare the General item slot from root. */
function declareItems(slots: SlotRegistry): () => void {
  return slots.register(
    { name: 'root', children: { [SLOT]: { kind: 'list', scope: 'root' } } } as never,
    () => null,
  )
}

/** Mirror the framework's inject choreography: bake a real instance from the
 * declared handle and hand its actions to the entry's inject factory. */
function faceOf(slots: SlotRegistry) {
  const entry = slots.entries(SLOT).find(e => e.component === AppearanceRow)!
  const handle = entry.store as ReturnType<typeof createAppearanceRowStore>
  const instance = handle.create()
  const face = (entry.inject as unknown as (a: typeof instance.actions) => AppearanceRowInjected)(instance.actions)
  return { entry, instance, face }
}

/** The same choreography for the font settings group entry. */
function fontSettingsFaceOf(slots: SlotRegistry) {
  const entry = slots.entries(SLOT).find(e => e.component === FontSettingsGroup)!
  const instance = (entry.store as ReturnType<typeof createFontRowStore>).create()
  const face = entry.inject!(...([instance.actions] as never[])) as Partial<FontSettingsInjected>
  return { entry, instance, face: face as FontSettingsInjected }
}

/** Deliver the keyboard service's arbitrated input while keeping its real catalog and bindings. */
function fontKeyboard(ctx: Context, runtime: Shortcuts['runtime'] = 'desktop', platform: ShortcutPlatform = 'macos') {
  onTestFinished(() => ctx.fiber.dispose())
  const registry = new ShortcutRegistry(runtime, platform)
  const listeners = new Set<(input: ShortcutFixedInput) => void>()
  const shortcuts: Pick<Shortcuts, 'runtime' | 'platform' | 'registerFixed' | 'describeBinding' | 'observeFixedInput'> = {
    runtime, platform,
    registerFixed: command => registry.registerFixed(command),
    describeBinding: (candidate) => {
      const binding = candidate === null ? null : normalizeBinding(candidate, platform)
      return { binding, keys: presentBinding(binding, platform).keys, issue: null, conflicts: [] }
    },
    observeFixedInput: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  ctx.provide('shortcuts', shortcuts)
  return {
    registry,
    press: (gesture: Partial<ShortcutGesture> = {}, context: Partial<ShortcutContext> = {}) => {
      const consume = vi.fn()
      for (const listener of listeners) listener({
        type: 'keydown', consume,
        gesture: { code: 'Equal', meta: platform === 'macos', control: platform !== 'macos', alt: false,
          shift: false, repeat: false, composing: false, defaultPrevented: false, ...gesture },
        context: { region: 'page', modal: null, target: null, ...context },
      })
      return consume
    },
    reset: () => { for (const listener of listeners) listener({ type: 'reset' }) },
  }
}

/** Isolate theme write outcomes behind the same registered keyboard input. */
async function keyboardTheme(host = stubSettingsScope<ThemeSettings>()) {
  const ctx = new Context()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const keyboard = fontKeyboard(ctx)
  const events: ThemeSnapshot[] = []
  ctx.on('theme/change', (snapshot) => { events.push(snapshot) })
  await ctx.plugin({ apply: (scope) => {
    scope.provide('theme', new ThemeRuntime(scope, host.scope))
  } }).await()
  return { theme: ctx.get('theme') as ThemeRuntime, keyboard, events, host }
}

describe('ui-theme apply', () => {
  it('declares the slot and locale services', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'settingsScope'])
  })

  it('provides the service, registers localized copy, and registers the row (declaration before or after apply)', async () => {
    const before = await bench()
    declareItems(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    expect(before.locale.bind(SETTINGS_NS)('appearance.title')).toBe('外观')
    before.locale.setLocale('en')
    expect(before.locale.bind(SETTINGS_NS)('appearance.title')).toBe('Appearance')
    const entry = before.slots.entries(SLOT).find(e => e.component === AppearanceRow)!
    expect(entry.options).toMatchObject({ id: 'appearance', order: 10 })

    const after = await bench()
    const fiber = after.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(after.slots.entries(SLOT)).toHaveLength(0)
    declareItems(after.slots)
    await Promise.resolve()
    expect(after.slots.entries(SLOT).some(e => e.component === AppearanceRow)).toBe(true)
  })

  it('projects service snapshots into the row store and routes face writes back', async () => {
    const b = await bench()
    declareItems(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const theme = b.ctx.get('theme') as ThemeRuntime
    // An event ahead of any inject hits the unbound-actions arm.
    theme.setTheme('dark')

    const { instance, face } = faceOf(b.slots)
    // The inject-time re-sync sealed the init window: the mirror is current.
    expect(instance.getSnapshot().preference).toBe('dark')
    // Copy rides the standard locale seat: the entry declares the namespace.
    expect(b.slots.entries(SLOT).find(e => e.component === AppearanceRow)!.locale).toBe(SETTINGS_NS)

    face.setTheme('system')
    expect(theme.getTheme().preference).toBe('system')
    expect(instance.getSnapshot().preference).toBe('system')
    await vi.waitFor(() => { expect(b.mutate).toHaveBeenCalledTimes(2) })
  })

  it('loads Host settings at boot and refreshes its namespace through the shared mirror', async () => {
    const b = await bench()
    // The shared mirror read once at bench time; a Host-side change reaches it
    // through the document invalidation, exactly as production announces one.
    b.setHostPreference('dark')
    b.ctx.remote.$dispatch('settings/document-updated', [THEME_SETTINGS_NAMESPACE, 0])
    declareItems(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const theme = b.ctx.get('theme') as ThemeRuntime
    await vi.waitFor(() => { expect(theme.getTheme().preference).toBe('dark') })
    // The mirror refreshes on every document commit (ns-agnostic); the scope's
    // derived value only moves when its own namespace changed.
    b.ctx.remote.$dispatch('settings/document-updated', ['unrelated', 0])
    await vi.waitFor(() => { expect(b.describe).toHaveBeenCalledTimes(3) })
    expect(theme.getTheme().preference).toBe('dark')
    b.setHostPreference('light')
    b.ctx.remote.$dispatch('settings/document-updated', [THEME_SETTINGS_NAMESPACE, 0])
    await vi.waitFor(() => { expect(theme.getTheme().preference).toBe('light') })
    b.setHostPreference('dark')
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(theme.getTheme().preference).toBe('dark') })

    const gateway = await bench(false)
    declareItems(gateway.slots)
    await gateway.ctx.plugin({ inject: [...inject], apply }).await()
    const gatewayTheme = gateway.ctx.get('theme') as ThemeRuntime
    await vi.waitFor(() => { expect(gateway.describe).toHaveBeenCalledOnce() })
    gatewayTheme.setTheme('dark')
    await vi.waitFor(() => { expect(gateway.mutate).toHaveBeenCalledOnce() })
  })

  it('activates before a slow settings refresh and converges when it settles', async () => {
    const b = await bench()
    b.setHostPreference('dark')
    const describe = b.describe.getMockImplementation()!
    const pending = deferred<Awaited<ReturnType<typeof describe>>>()
    b.describe.mockImplementationOnce(() => pending.promise)
    // The refresh hangs on the wire; the mirror keeps serving the last good
    // answer, so activation never blocks on the settings transport.
    b.ctx.remote.$dispatch('settings/document-updated', [THEME_SETTINGS_NAMESPACE, 0])
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const theme = b.ctx.get('theme') as ThemeRuntime
    expect(theme.getTheme().preference).toBe('system')
    pending.resolve(await describe())
    await vi.waitFor(() => { expect(theme.getTheme().preference).toBe('dark') })
    await fiber.dispose()
  })

  it('ignores an invalid preference crossing the settings wire', async () => {
    const b = await bench()
    b.setHostPreference('sepia')
    b.ctx.remote.$dispatch('settings/document-updated', [THEME_SETTINGS_NAMESPACE, 0])
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const theme = b.ctx.get('theme') as ThemeRuntime
    await vi.waitFor(() => { expect(b.describe).toHaveBeenCalledTimes(2) })
    expect(theme.getTheme().preference).toBe('system')
  })

  it('recovers after an HMR collapse of the declaring entry (stale disposer must not block)', async () => {
    const b = await bench()
    const host = declareItems(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries(SLOT)).toHaveLength(2)

    // Collapse: the declarer dies, the cascade removes our entry while the
    // apply closure still holds its (now stale) disposer.
    host()
    expect(b.slots.entries(SLOT)).toHaveLength(0)

    declareItems(b.slots)
    await Promise.resolve()
    expect(b.slots.entries(SLOT).some(e => e.component === AppearanceRow)).toBe(true)
  })

  it('teardown removes the row and the dictionaries; teardown without a declaration is quiet', async () => {
    const b = await bench()
    declareItems(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries(SLOT)).toHaveLength(2)
    await fiber.dispose()
    expect(b.slots.entries(SLOT)).toHaveLength(0)
    // Dictionary disposal: translation falls back to the bare key.
    expect(b.locale.bind(SETTINGS_NS)('appearance.title')).toBe('appearance.title')

    // Never-declared bench: the effect disposer's dispose arm stays undefined.
    const quiet = await bench()
    const f2 = quiet.ctx.plugin({ inject: [...inject], apply })
    await f2.await()
    await f2.dispose()
    expect(quiet.slots.entries(SLOT)).toHaveLength(0)
  })

  it('steps all font sizes in one snapshot, one field write per role', async () => {
    const { theme, keyboard, events, host } = await keyboardTheme()
    keyboard.press()
    expect(theme.getTheme().fontSizes).toEqual({ text: 15, code: 12, terminal: 14 })
    expect(host.set.mock.calls).toEqual([
      ['fontSize', 15],
      ['codeFontSize', 12],
      ['terminalFontSize', 14],
    ])
    expect(events).toHaveLength(1)
    expect(events[0]?.fontSizes).toEqual({ text: 15, code: 12, terminal: 14 })
  })

  it('continues stepping other font roles when one has reached its own limit', async () => {
    const { theme, keyboard, host } = await keyboardTheme()
    theme.setFontSize('text', 22)
    theme.setFontSize('code', 10)
    theme.setFontSize('terminal', 20)
    host.set.mockClear()
    keyboard.press()
    expect(theme.getTheme().fontSizes).toEqual({ text: 22, code: 11, terminal: 20 })
    expect(host.set.mock.calls).toEqual([['codeFontSize', 11]])
    keyboard.press({ code: 'Minus' })
    expect(theme.getTheme().fontSizes).toEqual({ text: 21, code: 10, terminal: 19 })
    keyboard.press({ code: 'Minus' })
    expect(theme.getTheme().fontSizes).toEqual({ text: 20, code: 10, terminal: 18 })
    expect(host.set.mock.calls).toEqual([
      ['codeFontSize', 11],
      ['fontSize', 21], ['codeFontSize', 10], ['terminalFontSize', 19],
      ['fontSize', 20], ['terminalFontSize', 18],
    ])
  })

  it('adopts all durable font sizes together after a refused batch settles', async () => {
    const host = stubSettingsScope<ThemeSettings>()
    const section: ThemeSettings = { preference: 'system', fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
      textFontFamily: '', codeFontFamily: '', terminalFontFamily: '' }
    host.publish({ status: 'ready', value: section, revision: 1, writable: true })
    const { theme, keyboard } = await keyboardTheme(host)
    const write = Promise.withResolvers<undefined>()
    host.set.mockReturnValue(write.promise)
    keyboard.press()
    host.publish({ value: section, revision: 2 })
    expect(theme.getTheme().fontSizes).toEqual({ text: 15, code: 12, terminal: 14 })
    write.resolve()
    await vi.waitFor(() => { expect(theme.getTheme().fontSizes).toEqual({ text: 14, code: 11, terminal: 13 }) })
  })

  it.each(['macos', 'windows', 'linux'] as const)('shares %s font shortcuts with the settings control and durable values', async (platform) => {
    const b = await bench()
    const keyboard = fontKeyboard(b.ctx, 'desktop', platform)
    declareItems(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const theme = b.ctx.get('theme') as ThemeRuntime
    const { instance, face } = fontSettingsFaceOf(b.slots)

    expect(keyboard.press()).toHaveBeenCalledOnce()
    expect(theme.getTheme().fontSizes).toEqual({ text: 15, code: 12, terminal: 14 })
    keyboard.press({ shift: true }, { region: 'editable' })
    expect(instance.getSnapshot().fontSizes).toEqual({ text: 16, code: 13, terminal: 15 })
    keyboard.press({ code: 'Minus' })
    expect(instance.getSnapshot().fontSizes).toEqual({ text: 15, code: 12, terminal: 14 })
    face.setFontSize('text', 20)
    keyboard.press()
    expect(theme.getTheme().fontSizes).toEqual({ text: 21, code: 13, terminal: 15 })
    // Per-role writes travel as single-op mutations: 3+3+3+1+3 by this point.
    await vi.waitFor(() => { expect(b.mutate).toHaveBeenCalledTimes(13) })
    expect(b.mutate.mock.calls.slice(-3).map(call => call[0].ops)).toEqual([
      [{ op: 'set', path: ['fontSize'], value: 21 }],
      [{ op: 'set', path: ['codeFontSize'], value: 13 }],
      [{ op: 'set', path: ['terminalFontSize'], value: 15 }],
    ])
    expect(theme.getTheme().fontSizes).toEqual({ text: 21, code: 13, terminal: 15 })

    await fiber.dispose()
    expect(keyboard.registry.fixedCatalog.getSnapshot()).toEqual([])
    expect(keyboard.press()).not.toHaveBeenCalled()
    expect(theme.getTheme().fontSizes.text).toBe(21)
    await b.ctx.fiber.dispose()
  })

  it('presents both desktop font actions with their accepted physical combinations', async () => {
    const b = await bench()
    const keyboard = fontKeyboard(b.ctx)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(keyboard.registry.fixedCatalog.getSnapshot().map(row => ({
      label: row.label, keys: row.keys, bindings: row.bindings.map(bindingKey),
    }))).toMatchInlineSnapshot(`
      [
        {
          "bindings": [
            "meta+Equal",
            "shift+meta+Equal",
          ],
          "keys": [
            "⌘",
            "=",
          ],
          "label": "增大字号",
        },
        {
          "bindings": [
            "meta+Minus",
          ],
          "keys": [
            "⌘",
            "-",
          ],
          "label": "减小字号",
        },
      ]
    `)
    await b.ctx.fiber.dispose()
  })

  it('consumes font shortcuts at either size limit without persisting another write', async () => {
    const b = await bench()
    const keyboard = fontKeyboard(b.ctx)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const theme = b.ctx.get('theme') as ThemeRuntime
    theme.setFontSize('text', 22)
    theme.setFontSize('code', 16)
    theme.setFontSize('terminal', 20)
    await vi.waitFor(() => { expect(b.mutate).toHaveBeenCalledTimes(3) })
    expect(keyboard.press()).toHaveBeenCalledOnce()
    expect(keyboard.press({ shift: true })).toHaveBeenCalledOnce()
    theme.setFontSize('text', 10)
    theme.setFontSize('code', 10)
    theme.setFontSize('terminal', 10)
    await vi.waitFor(() => { expect(b.mutate).toHaveBeenCalledTimes(6) })
    expect(keyboard.press({ code: 'Minus' })).toHaveBeenCalledOnce()
    expect(theme.getTheme().fontSizes).toEqual({ text: 10, code: 10, terminal: 10 })
    expect(b.mutate).toHaveBeenCalledTimes(6)
    await b.ctx.fiber.dispose()
  })

  it('leaves browser zoom and locally owned input unchanged', async () => {
    const browser = await bench()
    const web = fontKeyboard(browser.ctx, 'web')
    await browser.ctx.plugin({ inject: [...inject], apply }).await()
    expect(web.registry.fixedCatalog.getSnapshot()).toEqual([])
    expect(web.press()).not.toHaveBeenCalled()
    await browser.ctx.fiber.dispose()

    const b = await bench()
    const keyboard = fontKeyboard(b.ctx)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    for (const gesture of [
      { composing: true }, { defaultPrevented: true }, { repeat: true }, { alt: true },
      { meta: false }, { control: true }, { code: 'KeyA' }, { code: 'Minus', shift: true },
    ]) expect(keyboard.press(gesture)).not.toHaveBeenCalled()
    expect(keyboard.press({}, { region: 'terminal' })).not.toHaveBeenCalled()
    await b.ctx.fiber.dispose()
  })
})
