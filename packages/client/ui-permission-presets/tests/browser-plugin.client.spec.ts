/**
 * ui-permission browser half on a real cordis Context with fake command/
 * sessions faces: the plugin hangs the /permission popup decoration on the
 * host command; options flatten the session's permissions projection with
 * the current value active and `custom` excluded; availability follows the
 * projection key's presence; a pick submits the /permission line through
 * Session.command and surfaces rejection/unmatched as thrown errors; fiber
 * disposal removes the contribution (HMR safety). The same plugin registers
 * its Settings row and invalidates that row on host settings changes.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, PermissionCatalogDirectory, ProjectUiPolicyRuntime, SlotRegistry, type SessionId, type AccountPermissionAvailability } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CommandDecoration } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { PermissionCatalog, PermissionSelection } from '@deepseek-ai/dsh-permission-presets/client'
import {
  PermissionRow, type PermissionRowInjected,
} from '../src/client/PermissionRow.tsx'
import { apply, inject } from '../src/client/index.ts'
import { accessEn } from '../src/client/locales.ts'
import { DesktopConfirmationAction, type DesktopConfirmationInjected } from '../src/client/DesktopConfirmationAction.tsx'

const sid = (k: string): SessionId => k as SessionId

const CATALOG: PermissionCatalog = {
  options: [
    { value: 'read-only', name: 'read-only', description: 'Reads only.' },
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'danger-full-access', name: 'danger-full-access' },
  ],
}

const SELECT: PermissionSelection = {
  currentValue: 'workspace-write',
}

/** One permission namespace view whose schema advertises all three catalog presets. */
function permissionNs(defaultPreset: string, revision = 0): SettingsNamespaceView {
  return {
    ns: 'permission',
    schema: {
      uid: 7,
      refs: {
        1: { type: 'const', value: 'read-only' },
        2: { type: 'const', value: 'workspace-write' },
        3: { type: 'const', value: 'danger-full-access' },
        4: { type: 'union', list: [1, 2, 3] },
        7: { type: 'object', dict: { defaultPreset: 4 } },
      },
    },
    value: { defaultPreset },
    base: { defaultPreset: 'read-only' },
    applies: 'live',
    secrets: [],
    revision,
  }
}

async function bench() {
  const ctx = new Context()
  const policy = new ProjectUiPolicyRuntime()
  ctx.provide('projectUiPolicy', policy)
  const localHost = createSnapshotStore<{ executionAuthorityRequired?: boolean } | undefined>({ executionAuthorityRequired: false })
  const managedHost = createSnapshotStore<{ executionAuthorityRequired?: boolean } | undefined>({ executionAuthorityRequired: true })
  const managed = new Set<SessionId>()
  await ctx.plugin(SlotRegistry)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  // The plugin injects `remote`; forwarded events reach it through the same
  // `$dispatch` handoff the connection sink makes. The catalog namespace is a
  // mutable stub so a spec can republish the host's option table.
  const remote = new TestRemote(ctx)
  let catalog: PermissionCatalog = CATALOG
  let catalogError: { code: string; message: string } | undefined
  const readCatalog = () => Promise.resolve(catalogError === undefined
    ? { ok: true as const, value: catalog }
    : { ok: false as const, error: catalogError })
  Object.assign(remote, {
    permissionPresets: { catalog: readCatalog },
  })
  ctx.slots.register({
    name: 'root',
    children: {
      'settings.general.item': { kind: 'list', scope: 'root' },
      'conversation.input.left': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  const settingsNamespaces: SettingsNamespaceView[] = []
  const settingsMutate = vi.fn((): Promise<unknown> => Promise.reject(new Error('settings mutation is not exercised')))
  const connection = {
    api: {
      settings: {
        describe: () => Promise.resolve({
          rpcId: 'describe',
          result: { ok: true as const, value: { writable: true, hasDocument: false, namespaces: [...settingsNamespaces] } },
        }),
        mutate: settingsMutate,
      },
    },
    hostDescription: {
      getSnapshot: () => undefined,
      subscribe: () => () => {},
    },
    rpc: {
      call: (_channel: string, endpoint: string) => endpoint === 'permissionPresets/catalog'
        ? readCatalog()
        : Promise.reject(new Error('unexpected generic RPC call')),
    },
  }
  ctx.provide('connection', connection as never)
  // The runtime-owned directory wired exactly as runtime apply wires it: the
  // per-connection catalog transport, ownership-driven faces, and the host's
  // catalog-changed forward attributed to the delivering connection.
  const catalogDirectory = new PermissionCatalogDirectory(connection as never, createSnapshotStore({}))
  const releaseCatalog = ctx.provide('permissionCatalog', catalogDirectory)
  remote.$on('permission-presets/catalog-changed', () => { catalogDirectory.invalidateFor(connection as never) })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  let decoration: CommandDecoration | undefined
  ctx.provide('commandUi', {
    decorate(c: CommandDecoration) {
      decoration = c
      return () => { decoration = undefined }
    },
  })
  const values = new Map<SessionId, PermissionSelection>()
  const commands: string[] = []
  let commandResult: { ok: boolean; matched?: boolean } = { ok: true, matched: true }
  const session = (id: SessionId) => ({
    projections: {
      faceOf: (key: string) => ({
        getSnapshot: () => (key === 'permissions' ? values.get(id) : undefined),
        subscribe: () => () => {},
      }),
    },
    command: (line: string) => {
      commands.push(line)
      return Promise.resolve(commandResult.ok
        ? { ok: true as const, value: { matched: commandResult.matched ?? true } }
        : { ok: false as const, error: { code: 'internal', message: 'boom' } })
    },
  })
  ctx.provide('sessions', {
    binding: (id: SessionId) => (values.has(id)
      ? { sessionId: id, session: session(id), hostDescription: managed.has(id) ? managedHost : localHost }
      : undefined),
  })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return {
    ctx, fiber, values, commands, managed, localHost, managedHost,
    settingsNamespaces, settingsMutate,
    dropCatalog: () => { releaseCatalog() },
    qualify: (value: AccountPermissionAvailability) => { policy.setAccountPermissions(value) },
    setResult: (r: { ok: boolean; matched?: boolean }) => { commandResult = r },
    setCatalog: (next: PermissionCatalog) => {
      catalog = next
      remote.$dispatch('permission-presets/catalog-changed', [])
    },
    failCatalog: (error: { code: string; message: string }) => {
      catalogError = error
      remote.$dispatch('permission-presets/catalog-changed', [])
    },
    decoration: () => {
      if (decoration === undefined) return undefined
      if (decoration.ui.kind !== 'popupSelect') throw new Error('permission command must select an option')
      return { ...decoration, ui: decoration.ui }
    },
    permissionRow: () => ctx.slots.entries('settings.general.item')
      .find(entry => entry.component === PermissionRow),
  }
}

describe('ui-permission browser plugin', () => {
  it('binds desktop confirmation to the exact pane and removes the action on disposal', async () => {
    const b = await bench()
    const entry = b.ctx.slots.entries('conversation.input.left').find(item => item.options.id === 'desktop-confirmation')
    expect(entry?.component).toBe(DesktopConfirmationAction)
    const inject = entry?.inject as unknown as (sessionId: SessionId) => DesktopConfirmationInjected
    const connection = b.ctx.get('connection') as ConnectionHandle
    expect(inject(sid('local')).connection).toBe(connection)
    const scoped = { ...connection }
    const forSession = vi.fn((): ConnectionHandle => scoped)
    Object.assign(connection, { forSession })
    expect(inject(sid('managed')).connection).toBe(scoped)
    expect(forSession).toHaveBeenCalledWith(sid('managed'))
    await b.fiber.dispose()
    expect(b.ctx.slots.entries('conversation.input.left')).toHaveLength(0)
  })

  it('keeps the Host catalog intact and refuses unavailable account selections', async () => {
    const b = await bench()
    const c = b.decoration()!
    const session = { sessionId: sid('managed') }
    b.values.set(session.sessionId, { currentValue: 'auto' })
    b.managed.add(session.sessionId)
    b.setCatalog({ options: [...CATALOG.options, { value: 'auto', name: 'auto' }] })
    b.qualify('standard')
    const rows = await c.ui.options(session, new AbortController().signal)
    expect(rows.find(row => row.id === 'danger-full-access')).toMatchObject({ disabled: true })
    expect(rows.find(row => row.id === 'auto')).toMatchObject({ disabled: true, active: true })
    expect(rows.find(row => row.id === 'auto')?.detail).toContain('selected mode is unavailable')
    await expect(c.ui.onSelect({ id: 'auto', label: 'Auto' }, session)).rejects.toThrow('not eligible')
    expect(b.commands).toEqual([])
    expect(b.values.get(session.sessionId)?.currentValue).toBe('auto')
    b.qualify('full-and-auto')
    expect((await c.ui.options(session, new AbortController().signal)).every(row => row.disabled !== true)).toBe(true)
    expect(CATALOG.options).toHaveLength(3)
    await b.fiber.dispose()
  })

  it('invalidates only the owning target source and rechecks a stale option at submission', async () => {
    const b = await bench()
    const c = b.decoration()!
    const managed = { sessionId: sid('managed') }
    const local = { sessionId: sid('local') }
    b.values.set(managed.sessionId, SELECT)
    b.values.set(local.sessionId, SELECT)
    b.managed.add(managed.sessionId)
    b.qualify('full-and-auto')
    const managedChanged = vi.fn()
    const localChanged = vi.fn()
    const stopManaged = c.ui.subscribeInvalidation!(managed, managedChanged)
    const stopLocal = c.ui.subscribeInvalidation!(local, localChanged)
    b.managedHost.set(undefined)
    expect(managedChanged).toHaveBeenCalledOnce()
    expect(localChanged).not.toHaveBeenCalled()
    await expect(c.ui.onSelect({ id: 'danger-full-access', label: 'Full access' }, managed)).rejects.toThrow('unconfirmed')
    await c.ui.onSelect({ id: 'danger-full-access', label: 'Full access' }, local)
    expect(b.commands).toEqual(['/permission danger-full-access'])
    stopManaged(); stopLocal()
    await b.fiber.dispose()
  })
  it('hangs the /permission popup decoration on the host command', async () => {
    const b = await bench()
    const c = b.decoration()!
    expect(c.name).toBe('permission')
    expect(c.ui.kind).toBe('popupSelect')
    const row = b.permissionRow()!
    expect(row.options).toEqual({ id: 'permission', order: -20 })
    const injected = row.inject?.() as PermissionRowInjected | undefined
    expect(injected?.hooks.permission).toBeDefined()
    expect(typeof injected?.load).toBe('function')
    expect(typeof injected?.select).toBe('function')
    await injected!.load()
    await injected!.select('read-only')
  })

  it('availability follows the projection key; options mark the current value active and exclude custom', async () => {
    const b = await bench()
    const c = b.decoration()!
    const proj = { sessionId: sid('s1') }
    expect(c.available(proj)).toBe(false)
    b.setCatalog({ options: [...CATALOG.options, { value: 'custom', name: 'Custom' }] })
    b.values.set(sid('s1'), { currentValue: 'custom' })
    expect(c.available(proj)).toBe(true)
    const options = await c.ui.options(proj, new AbortController().signal)
    expect(options.map(option => option.id)).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
    expect(options.every(option => option.active !== true)).toBe(true)
    b.values.set(sid('s1'), SELECT)
    const again = await c.ui.options(proj, new AbortController().signal)
    expect(again.find(option => option.id === 'workspace-write')?.active).toBe(true)
    expect(again.find(option => option.id === 'read-only')?.detail).toBe('Reads only.')
    // Kebab-case names title-case; non-kebab host-configured names pass through.
    expect(again.map(option => option.label)).toEqual(['Read Only', 'Workspace Write', 'Full access'])
    expect(again.find(option => option.id === 'danger-full-access')?.confirmation).toEqual({
      title: 'Enable Full access?',
      description: accessEn['confirm.description'],
      acknowledgeLabel: 'I understand the risks and want to continue',
      cancelLabel: 'Cancel',
      confirmLabel: 'Enable Full access',
    })
    b.setCatalog({ options: [{ value: 'plain', name: 'Ask Every Time' }] })
    const passthrough = await c.ui.options(proj, new AbortController().signal)
    expect(passthrough[0]?.label).toBe('Ask Every Time')
    // A projection that vanished between availability and open rejects.
    await expect(c.ui.options({ sessionId: sid('ghost') }, new AbortController().signal))
      .rejects.toThrow(/not available on this host/)
    // A rejected catalog read surfaces the wire error instead of an empty popup.
    b.failCatalog({ code: 'unavailable', message: 'host offline' })
    await expect(c.ui.options(proj, new AbortController().signal))
      .rejects.toThrow(/permission catalog read failed: unavailable: host offline/)
  })

  it('rejects options when the connected host serves no permission catalog', async () => {
    const b = await bench()
    try {
      const c = b.decoration()!
      const proj = { sessionId: sid('s1') }
      b.values.set(sid('s1'), SELECT)
      b.dropCatalog()
      await expect(c.ui.options(proj, new AbortController().signal))
        .rejects.toThrow(/serves no permission presets/)
    } finally { await b.fiber.dispose() }
  })

  it('checks the default preset against current account eligibility before writing', async () => {
    const b = await bench()
    try {
      b.settingsNamespaces.push(permissionNs('read-only', 3))
      b.ctx.remote.$dispatch('settings/document-updated', ['permission', 1])
      const injected = b.permissionRow()!.inject?.() as PermissionRowInjected | undefined
      if (injected === undefined) throw new Error('expected the injected preset row')
      await injected.load()
      await vi.waitFor(() => {
        expect(injected.hooks.permission.getSnapshot()).toMatchObject({ status: 'ready', currentValue: 'read-only' })
      })
      // The unverified account cannot write the gated Full access preset.
      await injected.select('danger-full-access')
      expect(injected.hooks.permission.getSnapshot()).toMatchObject({
        status: 'error', error: accessEn['unavailable.unverified'],
      })
      expect(b.settingsMutate).not.toHaveBeenCalled()
      b.settingsMutate.mockResolvedValue({
        rpcId: 'mutate',
        result: { ok: true as const, value: permissionNs('workspace-write', 4) },
      })
      await injected.select('workspace-write')
      expect(b.settingsMutate).toHaveBeenCalledWith({
        ns: 'permission',
        ops: [{ op: 'set', path: ['defaultPreset'], value: 'workspace-write' }],
        expectedRevision: 3,
      })
      expect(injected.hooks.permission.getSnapshot()).toMatchObject({
        status: 'ready', currentValue: 'workspace-write', revision: 4,
      })
    } finally { await b.fiber.dispose() }
  })

  it('a pick submits the /permission line; rejection and unmatched throw', async () => {
    const b = await bench()
    const c = b.decoration()!
    const proj = { sessionId: sid('s1') }
    b.values.set(sid('s1'), SELECT)
    await c.ui.onSelect({ id: 'danger-full-access', label: 'danger-full-access' }, proj)
    expect(b.commands).toEqual(['/permission danger-full-access'])
    b.setResult({ ok: false })
    await expect(c.ui.onSelect({ id: 'read-only', label: 'read-only' }, proj)).rejects.toThrow(/permission switch failed/)
    b.setResult({ ok: true, matched: false })
    await expect(c.ui.onSelect({ id: 'read-only', label: 'read-only' }, proj)).rejects.toThrow(/no \/permission command/)
    // An unmaterialized session throws before any submit.
    await expect(c.ui.onSelect({ id: 'read-only', label: 'read-only' }, { sessionId: sid('ghost') }))
      .rejects.toThrow(/not materialized/)
  })

  it('disposal removes the decoration (HMR safety)', async () => {
    const b = await bench()
    expect(b.decoration()).toBeDefined()
    b.ctx.remote.$dispatch('settings/document-updated', ['another', 1])
    b.ctx.remote.$dispatch('settings/document-updated', ['permission', 1])
    b.ctx.emit('connection/reset')
    await b.fiber.dispose()
    expect(b.decoration()).toBeUndefined()
    expect(b.permissionRow()).toBeUndefined()
  })
})
