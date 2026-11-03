/** Account font controls retain their owner when the shared project Host is read-only. */
import { describe, expect, it, vi } from 'vitest'
import { createBrowserAccountPreferencesTransport } from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { AccountOrHostSettingsScopeController, AccountPreferencesMirror, AccountSettingsScopeController } from '../src/client/account-scope.ts'

const defaults = {
  preference: 'system', fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
  textFontFamily: '', codeFontFamily: '', terminalFontFamily: '',
}
const fields = [
  ['fontSize', 18], ['codeFontSize', 15], ['terminalFontSize', 16],
  ['textFontFamily', '"Noto Sans", sans-serif'], ['codeFontFamily', '"JetBrains Mono", monospace'],
  ['terminalFontFamily', '"Fira Code", monospace'],
] as const

describe('account fonts in shared project settings', () => {
  it.each(fields)('persists %s through account JSON without writing the project Host', async (field, value) => {
    const current = {
      revision: 0, migrated: true,
      values: { locale: {}, 'ui-theme': { ...defaults }, 'ui-conversation': { busyEnter: 'queue' } },
      overrides: { locale: {}, 'ui-theme': {} as Record<string, unknown>, 'ui-conversation': {} },
    }
    const fontOverrides = new Map<string, unknown>()
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        if (typeof init.body !== 'string') throw new Error('Account preference requests require JSON text')
        const mutation = JSON.parse(init.body) as {
          namespace: string
          field: keyof typeof defaults
          operation: string
          value?: unknown
        }
        expect(mutation.namespace).toBe('ui-theme')
        current.revision++
        if (mutation.operation === 'unset') {
          Object.assign(current.values['ui-theme'], { [mutation.field]: defaults[mutation.field] })
          fontOverrides.delete(mutation.field)
        } else {
          Object.assign(current.values['ui-theme'], { [mutation.field]: mutation.value })
          fontOverrides.set(mutation.field, mutation.value)
        }
        current.overrides['ui-theme'] = Object.fromEntries(fontOverrides)
      }
      return new Response(JSON.stringify(current), { headers: { 'content-type': 'application/json' } })
    })
    const api = createBrowserAccountPreferencesTransport(fetcher)
    const mirror = new AccountPreferencesMirror(api)
    const account = new AccountSettingsScopeController(api, { namespace: 'ui-theme' }, mirror)
    const snapshot: SettingsScopeSnapshot<unknown> = {
      status: 'ready',
      value: { ...defaults, fontSize: 21, codeFontSize: 16, terminalFontSize: 19,
        textFontFamily: 'Project Text', codeFontFamily: 'Project Code', terminalFontFamily: 'Project Terminal' },
      base: { ...defaults }, user: { fontSize: 21, textFontFamily: 'Project Text' }, revision: 0,
      writable: false, writableReason: 'project', write: { status: 'idle' }, mode: 'host',
    }
    const hostSet = vi.fn(async () => { throw new Error('Project Host must remain read-only') })
    const hostUnset = vi.fn(async () => { throw new Error('Project Host must remain read-only') })
    const host: SettingsScope<unknown> = {
      getSnapshot: () => snapshot, subscribe: () => () => {},
      set: hostSet, unset: hostUnset,
    }
    const scope = new AccountOrHostSettingsScopeController(account, host, mirror, 'ui-theme')
    try {
      await mirror.ensure()
      expect(scope.getFieldControlState(field)).toMatchObject({ writable: true, mode: 'account' })
      await scope.set(field, value)
      expect(scope.getSnapshot().value).toMatchObject({ [field]: value })
      expect(scope.getSnapshot().user).toMatchObject({ [field]: value })
      await scope.unset(field)
      expect(scope.getSnapshot().value).toMatchObject({ [field]: defaults[field] })
      expect(scope.getSnapshot().user).not.toHaveProperty(field)
      expect(hostSet).not.toHaveBeenCalled()
      expect(hostUnset).not.toHaveBeenCalled()
      expect(fetcher).toHaveBeenCalledTimes(3)
    } finally { await scope.dispose(); await mirror.dispose() }
  })
})
