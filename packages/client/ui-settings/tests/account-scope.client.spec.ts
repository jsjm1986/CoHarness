import { describe, expect, it, vi } from 'vitest'
import type {
  AccountPreferenceMutation, AccountPreferencesTransport, AccountPreferencesView,
} from '@deepseek-ai/dsh-client-connection/client'
import {
  AccountOrHostSettingsScopeController,
  AccountPreferencesMirror,
  AccountSettingsScopeController,
} from '../src/client/account-scope.ts'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail })
  return { promise, resolve, reject }
}

const initial: AccountPreferencesView = {
  revision: 0,
  migrated: true,
  values: {
    locale: {},
    'ui-theme': { preference: 'system' },
    'ui-conversation': { busyEnter: 'queue', chatContentWidth: 748, chatFontSize: 14 },
  },
  overrides: { locale: {}, 'ui-theme': {}, 'ui-conversation': {} },
}

function transport(): AccountPreferencesTransport & { calls: AccountPreferenceMutation[] } {
  let current = structuredClone(initial)
  const calls: AccountPreferenceMutation[] = []
  return {
    calls,
    async describe() { return structuredClone(current) },
    async mutate(mutation) {
      calls.push(mutation)
      current = {
        ...current,
        revision: current.revision + 1,
        values: {
          ...current.values,
          [mutation.namespace]: mutation.namespace === 'locale'
            ? (mutation.operation === 'unset' ? {} : { preference: mutation.value as 'zh' | 'en' })
            : mutation.namespace === 'ui-theme'
              ? { preference: mutation.operation === 'unset' ? 'system' : mutation.value as 'light' | 'dark' | 'system' }
              : {
                ...current.values['ui-conversation'],
                ...(mutation.field === 'busyEnter'
                  ? { busyEnter: mutation.operation === 'unset' ? 'queue' : mutation.value as 'queue' | 'steer' }
                  : mutation.field === 'chatContentWidth'
                    ? { chatContentWidth: mutation.operation === 'unset' ? 748 : mutation.value as number }
                    : { chatFontSize: mutation.operation === 'unset' ? 14 : mutation.value as number }),
              },
        },
        overrides: {
          ...current.overrides,
          [mutation.namespace]: mutation.operation === 'unset'
            ? {}
            : mutation.namespace === 'locale'
              ? { preference: mutation.value as 'zh' | 'en' }
              : mutation.namespace === 'ui-theme'
                ? { preference: mutation.value as 'light' | 'dark' | 'system' }
                : {
                  ...(mutation.field === 'busyEnter' ? { busyEnter: mutation.value as 'queue' | 'steer' } : {}),
                  ...(mutation.field === 'chatContentWidth' ? { chatContentWidth: mutation.value as number } : {}),
                  ...(mutation.field === 'chatFontSize' ? { chatFontSize: mutation.value as number } : {}),
                },
        },
      }
      return structuredClone(current)
    },
  }
}

function hostScope(): SettingsScope<unknown> {
  const snapshot: SettingsScopeSnapshot<unknown> = {
    status: 'ready', value: { preference: 'system' }, base: {}, user: {}, revision: 1,
    writable: true, writableReason: undefined, write: { status: 'idle' }, mode: 'host',
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: vi.fn(async () => {}),
    unset: vi.fn(async () => {}),
  }
}

describe('account settings scope', () => {
  it('reports an unavailable mirror without a transport and ignores unknown namespaces', async () => {
    const mirror = new AccountPreferencesMirror(undefined)
    expect(mirror.getSnapshot()).toMatchObject({ status: 'unavailable', unsupported: true })
    await mirror.ensure()
    await mirror.load()
    expect(mirror.namespace('unknown')).toBeUndefined()
    const scope = new AccountSettingsScopeController(undefined, { namespace: 'ui-theme' }, mirror)
    expect(scope.getSnapshot()).toMatchObject({ status: 'unavailable', writable: false, writableReason: 'account' })
    await scope.set('preference', 'dark')
    await scope.unset('preference')
    await scope.dispose()
  })

  it('projects every account namespace and preserves a transient read failure after a good view', async () => {
    const api = transport()
    const mirror = new AccountPreferencesMirror(api)
    await mirror.ensure()
    expect(mirror.namespace('locale')).toMatchObject({ ns: 'locale', base: {}, user: {} })
    expect(mirror.namespace('ui-theme')).toMatchObject({ ns: 'ui-theme', base: { preference: 'system' } })
    expect(mirror.namespace('ui-conversation')).toMatchObject({
      ns: 'ui-conversation', base: { busyEnter: 'queue', chatContentWidth: 748, chatFontSize: 14 },
    })
    expect(mirror.namespace('other')).toBeUndefined()

    const failing: AccountPreferencesTransport = {
      describe: async () => { throw new Error('temporary account store failure') },
      mutate: async () => initial,
    }
    const held = new AccountPreferencesMirror(failing)
    held.accept(initial)
    await held.load()
    expect(held.getSnapshot()).toMatchObject({ status: 'ready', error: 'temporary account store failure', unsupported: false })
  })

  it('coalesces an in-flight account read and skips a ready read', async () => {
    const pending = deferred<AccountPreferencesView>()
    const api: AccountPreferencesTransport = {
      describe: () => pending.promise.then(value => structuredClone(value)),
      mutate: async () => structuredClone(initial),
    }
    const mirror = new AccountPreferencesMirror(api)
    const first = mirror.load()
    expect(mirror.load()).toBe(first)
    pending.resolve(initial)
    await first
    await expect(mirror.ensure()).resolves.toBeUndefined()
  })

  it('keeps malformed account values unavailable and reports blocked or invalid writes', async () => {
    const malformed = new AccountPreferencesMirror({
      describe: async () => structuredClone(initial),
      mutate: async () => initial,
    })
    const malformedApi: AccountPreferencesTransport = {
      describe: async () => structuredClone(initial),
      mutate: async () => initial,
    }
    const malformedScope = new AccountSettingsScopeController(
      malformedApi,
      { namespace: 'ui-theme', decode: () => undefined },
      malformed,
    )
    malformed.accept(initial)
    expect(malformedScope.getSnapshot().status).toBe('unavailable')
    await malformedScope.dispose()

    const arrayMirror = new AccountPreferencesMirror({
      describe: async () => structuredClone(initial),
      mutate: async () => initial,
    })
    const arrayApi: AccountPreferencesTransport = {
      describe: async () => structuredClone(initial),
      mutate: async () => initial,
    }
    const arrayScope = new AccountSettingsScopeController(arrayApi, { namespace: 'ui-theme' }, arrayMirror)
    arrayMirror.accept({ ...initial, values: { ...initial.values, 'ui-theme': [] as never } })
    expect(arrayScope.getSnapshot().status).toBe('unavailable')
    await arrayScope.dispose()

    const api: AccountPreferencesTransport = {
      describe: async () => structuredClone(initial),
      mutate: async (mutation) => {
        if ((mutation as { field: string }).field === 'bad') throw new Error('write failed')
        return structuredClone(initial)
      },
    }
    const mirror = new AccountPreferencesMirror(api)
    const scope = new AccountSettingsScopeController(api, { namespace: 'ui-theme' }, mirror)
    await mirror.ensure()
    await scope.set('preference.with.dot', 'dark')
    expect(scope.getSnapshot().write).toMatchObject({ status: 'error', code: 'invalid-field' })
    await scope.set('preference', 'dark')
    expect(scope.getSnapshot().write).toMatchObject({ status: 'idle' })
    await scope.set('bad', 'dark')
    expect(scope.getSnapshot().write).toMatchObject({ status: 'error', code: 'transport' })
    await scope.dispose()
  })

  it('blocks writes while the account mirror has no namespace and handles non-Error failures', async () => {
    const api: AccountPreferencesTransport = {
      describe: async () => { throw 'account read failed' },
      mutate: async () => { throw 'account write failed' },
    }
    const mirror = new AccountPreferencesMirror(api)
    const scope = new AccountSettingsScopeController(api, { namespace: 'ui-theme' }, mirror)
    await mirror.load()
    await scope.set('preference', 'dark')
    expect(scope.getSnapshot().write).toMatchObject({ status: 'blocked', reason: 'account' })
    await scope.dispose()
  })

  it('does not publish a response that settles after disposal', async () => {
    const pending = deferred<AccountPreferencesView>()
    const api: AccountPreferencesTransport = {
      describe: async () => structuredClone(initial),
      mutate: async () => pending.promise,
    }
    const mirror = new AccountPreferencesMirror(api)
    const scope = new AccountSettingsScopeController(api, { namespace: 'ui-theme' }, mirror)
    await mirror.ensure()
    const write = scope.set('preference', 'dark')
    await vi.waitFor(() => { expect(scope.getSnapshot().write.status).toBe('saving') })
    const disposed = scope.dispose()
    pending.resolve(structuredClone(initial))
    await Promise.all([write, disposed])
    expect(scope.getSnapshot().write.status).toBe('saving')
  })

  it('drops a superseded failed write and reports coded non-Error failures', async () => {
    const first = deferred<AccountPreferencesView>()
    const requests: AccountPreferenceMutation[] = []
    const api: AccountPreferencesTransport = {
      describe: async () => structuredClone(initial),
      mutate: async (mutation) => {
        requests.push(mutation)
        if (requests.length === 1) return first.promise
        throw { code: 'coded-failure' }
      },
    }
    const mirror = new AccountPreferencesMirror(api)
    const scope = new AccountSettingsScopeController(api, { namespace: 'ui-theme' }, mirror)
    await mirror.ensure()
    const firstWrite = scope.set('preference', 'dark')
    await vi.waitFor(() => { expect(requests).toHaveLength(1) })
    const secondWrite = scope.set('preference', 'light')
    first.reject(new Error('first write failed'))
    await Promise.all([firstWrite, secondWrite])
    expect(scope.getSnapshot().write).toMatchObject({ status: 'error', code: 'coded-failure', message: '[object Object]' })
  })

  it('loads, writes, and clears one account namespace through the shared face', async () => {
    const api = transport()
    const mirror = new AccountPreferencesMirror(api)
    const scope = new AccountSettingsScopeController(api, { namespace: 'ui-theme' }, mirror)
    await mirror.ensure()
    expect(scope.getSnapshot()).toMatchObject({ status: 'ready', mode: 'account', owner: 'account', writable: true })
    await scope.set('preference', 'dark')
    expect(api.calls[0]).toMatchObject({ namespace: 'ui-theme', operation: 'set', value: 'dark', expectedRevision: 0 })
    expect(scope.getSnapshot().value).toEqual({ preference: 'dark' })
    await scope.unset('preference')
    expect(api.calls[1]).toMatchObject({ namespace: 'ui-theme', operation: 'unset', expectedRevision: 1 })
    expect(scope.getSnapshot().value).toEqual({ preference: 'system' })
    await scope.dispose()
  })

  it('keeps numeric conversation display writes numeric on the account transport', async () => {
    const api = transport()
    const mirror = new AccountPreferencesMirror(api)
    const scope = new AccountSettingsScopeController(api, { namespace: 'ui-conversation' }, mirror)
    await mirror.ensure()
    await scope.set('chatContentWidth', 920)
    await scope.set('chatFontSize', 16)
    expect(api.calls).toEqual([
      expect.objectContaining({ field: 'chatContentWidth', value: 920 }),
      expect.objectContaining({ field: 'chatFontSize', value: 16 }),
    ])
    expect(scope.getSnapshot().value).toMatchObject({ chatContentWidth: 920, chatFontSize: 16 })
    await scope.dispose()
  })

  it('uses a completed response as the fence for a queued successor', async () => {
    const first = deferred<AccountPreferencesView>()
    let current = structuredClone(initial)
    let call = 0
    const requests: AccountPreferenceMutation[] = []
    const api: AccountPreferencesTransport = {
      describe: async () => structuredClone(current),
      mutate: async (mutation) => {
        call += 1
        requests.push(mutation)
        if (mutation.expectedRevision !== undefined && mutation.expectedRevision !== current.revision) {
          throw new Error('account preference revision conflict')
        }
        if (call === 1) {
          current = await first.promise
          return structuredClone(current)
        }
        current = {
          ...current,
          revision: current.revision + 1,
          values: {
            ...current.values,
            'ui-theme': { preference: mutation.value as 'light' | 'dark' | 'system' },
          },
          overrides: {
            ...current.overrides,
            'ui-theme': { preference: mutation.value as 'light' | 'dark' | 'system' },
          },
        }
        return structuredClone(current)
      },
    }
    const mirror = new AccountPreferencesMirror(api)
    const scope = new AccountSettingsScopeController(api, { namespace: 'ui-theme' }, mirror)
    await mirror.ensure()
    const dark = scope.set('preference', 'dark')
    await vi.waitFor(() => { expect(call).toBe(1) })
    const light = scope.set('preference', 'light')
    first.resolve({
      ...current,
      revision: 1,
      values: { ...current.values, 'ui-theme': { preference: 'dark' } },
      overrides: { ...current.overrides, 'ui-theme': { preference: 'dark' } },
    })
    await Promise.all([dark, light])
    expect(requests[1]).toMatchObject({ expectedRevision: 1, value: 'light' })
    expect(scope.getSnapshot().value).toEqual({ preference: 'light' })
    await scope.dispose()
  })

  it('falls back to the Host scope only for an unsupported account endpoint', async () => {
    const mirror = new AccountPreferencesMirror({
      describe: async () => { throw Object.assign(new Error('missing'), { status: 404 }) },
      mutate: async () => initial,
    })
    const account = new AccountSettingsScopeController({
      describe: () => Promise.reject(Object.assign(new Error('missing'), { status: 404 })),
      mutate: () => Promise.resolve(initial),
    }, { namespace: 'locale' }, mirror)
    const host = hostScope()
    const composite = new AccountOrHostSettingsScopeController(account, host, mirror)
    await mirror.ensure()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(composite.getSnapshot().mode).toBe('host')
    await composite.dispose()
  })

  it('delegates account-or-host writes before and after an account fallback', async () => {
    const accountApi = transport()
    const mirror = new AccountPreferencesMirror(accountApi)
    const account = new AccountSettingsScopeController(accountApi, { namespace: 'ui-theme' }, mirror)
    const hostSet = vi.fn(async () => {})
    const hostUnset = vi.fn(async () => {})
    let hostListener: (() => void) | undefined
    const host = {
      ...hostScope(),
      set: hostSet,
      unset: hostUnset,
      subscribe: (listener: () => void) => {
        hostListener = listener
        return () => { hostListener = undefined }
      },
    }
    const composite = new AccountOrHostSettingsScopeController(account, host, mirror)
    await mirror.ensure()
    await composite.set('preference', 'dark')
    expect(accountApi.calls).toHaveLength(1)
    const unsupported = new AccountPreferencesMirror({
      describe: async () => { throw Object.assign(new Error('missing'), { status: 501 }) },
      mutate: async () => initial,
    })
    const fallbackAccount = new AccountSettingsScopeController(accountApi, { namespace: 'ui-theme' }, unsupported)
    const fallback = new AccountOrHostSettingsScopeController(fallbackAccount, host, unsupported)
    await unsupported.ensure()
    await new Promise(resolve => setTimeout(resolve, 0))
    await fallback.set('preference', 'light')
    expect(hostSet).toHaveBeenCalledWith('preference', 'light')
    await fallback.unset('preference')
    expect(hostUnset).toHaveBeenCalledWith('preference')
    expect(fallback.subscribe(() => {})).toEqual(expect.any(Function))
    const retainedHostListener = hostListener
    retainedHostListener?.()
    await fallback.dispose()
    await composite.dispose()
    retainedHostListener?.()
  })
})
