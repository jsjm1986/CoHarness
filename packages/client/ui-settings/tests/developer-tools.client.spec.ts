/** Developer-tool choices share settings validation, persistence and accepted-state publication. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import {
  DEVELOPER_TOOLS_NAMESPACE, DeveloperToolsSettingsSchema, type DeveloperToolsSettings,
} from '../src/developer-tools-settings.ts'
import { DeveloperToolsPreference } from '../src/client/developer-tools.ts'
import { SettingsDescribeMirror } from '../src/client/settings-mirror.ts'
import { SettingsScopeController } from '../src/client/settings-scope.ts'
import { SettingsSchemaService } from '../src/client/schema.ts'

const settingsSchema = new SettingsSchemaService(new Context())

let rpc = 0

function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `devtools-${rpc++}` as never, result: { ok: true, value } }
}

function view(value: unknown, revision = 0): SettingsNamespaceView {
  return {
    ns: DEVELOPER_TOOLS_NAMESPACE,
    schema: DeveloperToolsSettingsSchema.toJSON(),
    value,
    applies: 'live',
    secrets: [],
    revision,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

/** A host-mode mirror plus a developer-tools scope over one fake wire. */
function devToolsScope(api: {
  describe?: ReturnType<typeof vi.fn>
  mutate?: ReturnType<typeof vi.fn>
}) {
  const wire = { settings: api } as never
  const mirror = new SettingsDescribeMirror(wire)
  const scope = new SettingsScopeController<DeveloperToolsSettings>(
    wire, { namespace: DEVELOPER_TOOLS_NAMESPACE }, mirror, 'host', settingsSchema,
  )
  return { mirror, scope, preference: new DeveloperToolsPreference(scope) }
}

describe('DeveloperToolsPreference', () => {
  it.each([false, true])('withholds features during a delayed Host read before accepting %s', async (enabled) => {
    const pending = deferred<ReturnType<typeof view>>()
    const describe = vi.fn().mockImplementation(() =>
      pending.promise.then(namespace => ok({ writable: true, hasDocument: true, namespaces: [namespace] })))
    const { mirror, preference } = devToolsScope({ describe })
    const changed = vi.fn()
    const dispose = preference.enabled.subscribe(changed)
    expect(preference.enabled.getSnapshot()).toBe(false)
    void mirror.ensure()
    pending.resolve(view({ enabled }, 1))
    await vi.waitFor(() => { expect(preference.enabled.getSnapshot()).toBe(enabled) })
    expect(changed).toHaveBeenCalledTimes(enabled ? 1 : 0)
    dispose()
  })

  it('keeps features disabled when the initial Host read fails', async () => {
    const describe = vi.fn().mockRejectedValue(new Error('disconnected'))
    const { mirror, preference } = devToolsScope({ describe })
    await mirror.ensure().catch(() => {})
    expect(preference.enabled.getSnapshot()).toBe(false)
  })

  it('reports a refused Host write after recovering accepted state', async () => {
    const describe = vi.fn().mockResolvedValue(
      ok({ writable: true, hasDocument: true, namespaces: [view({ enabled: false }, 1)] }))
    const mutate = vi.fn().mockResolvedValue({
      rpcId: `devtools-${rpc++}`,
      result: { ok: false, error: { code: 'settings-rejected', message: 'conflict', details: {} } },
    })
    const { mirror, preference } = devToolsScope({ describe, mutate })
    await mirror.ensure()
    await expect(preference.setEnabled(true)).rejects.toThrow('not saved')
    expect(mutate).toHaveBeenCalledExactlyOnceWith({
      ns: DEVELOPER_TOOLS_NAMESPACE,
      ops: [{ op: 'set', path: ['enabled'], value: true }],
      expectedRevision: 1,
    })
    // The refused write re-read the document; the accepted value stands.
    await vi.waitFor(() => { expect(describe).toHaveBeenCalledTimes(2) })
    expect(preference.enabled.getSnapshot()).toBe(false)
  })

  it('persists an accepted write and follows the published acceptance', async () => {
    const describe = vi.fn().mockResolvedValue(
      ok({ writable: true, hasDocument: true, namespaces: [view({ enabled: false }, 1)] }))
    const mutate = vi.fn().mockResolvedValue(ok(view({ enabled: true }, 2)))
    const { mirror, preference } = devToolsScope({ describe, mutate })
    await mirror.ensure()
    await preference.setEnabled(true)
    expect(preference.enabled.getSnapshot()).toBe(true)
  })

  it('stays off until accepted settings arrive, then follows a stored false and external changes', async () => {
    const host = stubSettingsScope<DeveloperToolsSettings>()
    const preference = new DeveloperToolsPreference(host.scope)
    expect(preference.enabled.getSnapshot()).toBe(false)
    const notify = vi.fn()
    const dispose = preference.enabled.subscribe(notify)
    host.publish({ status: 'ready', value: { enabled: false } })
    expect(preference.enabled.getSnapshot()).toBe(false)
    expect(notify).not.toHaveBeenCalled()
    await preference.setEnabled(true)
    expect(host.set).toHaveBeenCalledWith('enabled', true)
    host.publish({ value: { enabled: true } })
    expect(preference.enabled.getSnapshot()).toBe(true)
    expect(notify).toHaveBeenCalledOnce()
    dispose()
  })

  it('ignores host revisions that do not change enablement', () => {
    const host = stubSettingsScope<DeveloperToolsSettings>()
    const preference = new DeveloperToolsPreference(host.scope)
    const notify = vi.fn()
    const dispose = preference.enabled.subscribe(notify)
    host.publish({ revision: 1 })
    host.publish({ value: { enabled: false } })
    expect(notify).not.toHaveBeenCalled()
    host.publish({ value: { enabled: true } })
    expect(notify).toHaveBeenCalledOnce()
    dispose()
  })

  it('keeps an unavailable Host namespace disabled', () => {
    const host = stubSettingsScope<DeveloperToolsSettings>()
    const preference = new DeveloperToolsPreference(host.scope)
    host.publish({ status: 'unavailable' })
    expect(preference.enabled.getSnapshot()).toBe(false)
  })
})
