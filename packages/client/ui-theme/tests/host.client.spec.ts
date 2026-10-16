import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_PREFERENCE, THEME_SETTINGS_NAMESPACE, apply,
} from '@deepseek-ai/dsh-client-ui-theme'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

const DEFAULT_SECTION = {
  preference: DEFAULT_PREFERENCE, fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
  textFontFamily: '', codeFontFamily: '', terminalFontFamily: '',
}

describe('ui-theme host', () => {
  it('registers, validates, and disposes the durable theme namespace with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const ns = settingsNamespace(THEME_SETTINGS_NAMESPACE)
    expect(ctx.settings.get(ns)).toEqual(DEFAULT_SECTION)
    await ctx.settings.update(ns, { preference: 'dark', fontSize: 10, codeFontSize: 16, codeFontFamily: '"Iosevka"' })
    expect(ctx.settings.get(ns)).toEqual({ ...DEFAULT_SECTION, preference: 'dark', fontSize: 10, codeFontSize: 16, codeFontFamily: '"Iosevka"' })
    await ctx.settings.update(ns, { fontSize: 22 })
    expect(ctx.settings.get(ns)).toMatchObject({ fontSize: 22 })
    await expect(ctx.settings.update(ns, { preference: 'sepia' })).rejects.toThrow()
    await expect(ctx.settings.update(ns, { fontSize: 9 })).rejects.toThrow()
    await expect(ctx.settings.update(ns, { fontSize: 23 })).rejects.toThrow()
    await expect(ctx.settings.update(ns, { codeFontSize: 17 })).rejects.toThrow()
    await expect(ctx.settings.update(ns, { terminalFontSize: 9 })).rejects.toThrow()
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(ns)
  })

  it('renders the current durable preference and disposes the index transform', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    let transform: ((html: string) => string) | undefined
    let disposed = false
    ctx.provide('webServer', {
      tapIndex: (next: (html: string) => string) => {
        transform = next
        return () => { disposed = true }
      },
    } as WebServer)
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    expect(transform?.('<body></body>')).toContain('const preference = "system"')
    await ctx.settings.update(settingsNamespace(THEME_SETTINGS_NAMESPACE), { preference: 'dark' })
    expect(transform?.('<body></body>')).toContain('const preference = "dark"')
    await fiber.dispose()
    expect(disposed).toBe(true)
    expect(transform?.('<body></body>')).toContain('const preference = "system"')
  })

  it('uses the system preference when only an HTTP server exists', async () => {
    const ctx = new Context()
    let transform: ((html: string) => string) | undefined
    ctx.provide('webServer', {
      tapIndex: (next: (html: string) => string) => {
        transform = next
        return () => undefined
      },
    } as WebServer)
    await ctx.plugin({ apply }).await()
    expect(transform?.('<body></body>')).toContain('const preference = "system"')
  })
})
