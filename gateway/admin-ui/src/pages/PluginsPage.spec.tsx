/** Scope changes discard private workflow state before the next runtime can answer. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import * as api from '../api.ts'
import { runtimeFixture, runtimePageFixture } from '../components/runtime-fixture.ts'
import { pluginManagementRemote } from '../plugins/transport.ts'
import type { PluginManagementRemote } from '../plugins/transport.ts'
import type { PluginInfo, PluginManagementCatalog } from '../../../../packages/boot/plugin-manager/src/types.ts'
import { StrictMode } from 'react'
import { PluginsPage } from './PluginsPage.tsx'

vi.mock('../api.ts', () => ({
  getAdminComputerContext: vi.fn(), listRuntimeEnvironments: vi.fn(), listUserRuntimes: vi.fn(),
  getRuntimeAllocationPolicy: vi.fn(), saveRuntimeAllocationPolicy: vi.fn(), allocateUserRuntime: vi.fn(), operateRuntime: vi.fn(),
  listUsers: vi.fn(), listProjects: vi.fn(), pluginManagementTarget: vi.fn(),
  getPluginPolicy: vi.fn(), setPluginPolicy: vi.fn(),
  pluginManagementState: vi.fn(), pluginManagementSaveState: vi.fn(), pluginManagementOverview: vi.fn(async () => []),
}))
vi.mock('../plugins/transport.ts', () => ({ pluginManagementRemote: vi.fn() }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const target: api.PluginManagementTarget = { nodeId: 'node-a', target: { kind: 'user', id: 1, runtimeId: runtimeFixture('user', 1).id }, generation: 3 }
let remoteFixture: PluginManagementRemote
const stateView: api.PluginManagementState = {
  revision: '2',
  state: { entries: [], bundles: ['core'] },
  appliedRevision: '2',
  generation: 3,
  observed: { entries: [], bundles: ['core'] },
}
beforeEach(() => {
  vi.resetAllMocks()
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  })
  vi.mocked(api.getAdminComputerContext).mockResolvedValue({ nodeId: 'node-a' as api.RuntimeNodeId, name: 'Computer A', forwardingEnabled: true })
  vi.mocked(api.listUserRuntimes).mockImplementation(async id => runtimePageFixture('user', id))
  vi.mocked(api.listRuntimeEnvironments).mockResolvedValue(runtimePageFixture('project', 7))
  vi.mocked(api.getRuntimeAllocationPolicy).mockResolvedValue({ revision: '0', maxTotal: 8, maxPerNode: 4, source: 'organization' })

  vi.mocked(api.listUsers).mockResolvedValue([{ id: 1, displayName: 'Alice' } as api.AdminUser])
  vi.mocked(api.listProjects).mockResolvedValue([{ id: 7, name: 'Shared' } as api.Project])
  vi.mocked(api.pluginManagementTarget).mockImplementation(async (kind, id, _signal, runtimeId) => ({ ...target, target: { kind, id, runtimeId } }))
  vi.mocked(api.pluginManagementState).mockResolvedValue(stateView)
  vi.mocked(api.getPluginPolicy).mockImplementation(async (kind, id) => ({ kind, id, enabled: true, revision: '2' }))
  const unused = vi.fn(async () => { throw new Error('unexpected mutation') })
  remoteFixture = {
    settings: { describe: vi.fn(async () => ({ ok: true as const, value: { writable: true, hasDocument: false, namespaces: [] } })), mutate: unused },
    pluginInventory: { list: vi.fn(async () => ({ ok: true as const, value: { managementAvailable: true, entries: [] } })) },
    pluginManager: {
      catalog: vi.fn(async () => ({ ok: true as const, value: { managementAvailable: true, manage: true, bundles: [], plugins: [] } })),
      listPlugins: vi.fn(async () => ({ ok: true as const, value: [] })),
      listBundles: vi.fn(async () => ({ ok: true as const, value: [] })),
      inspect: unused, setPluginEnabled: unused, setBundleEnabled: unused,
      describePluginConfig: unused, setPluginConfig: unused,
      installBundle: unused, cancelInstall: unused, removeBundle: unused,
      registries: vi.fn(async () => ({ ok: true as const, value: { registry: null, fallbackRegistries: [], resolved: null } })),
      waitForInstall: unused,
    },
    pluginRegistryProbe: { fastest: unused },
  }
  vi.mocked(pluginManagementRemote).mockReturnValue(remoteFixture)
})
async function chooseUser() {
  const user = userEvent.setup()
  await waitFor(() => expect(screen.getByLabelText('插件管理对象').querySelector('option[value="user:1"]')).toBeTruthy())
  await user.selectOptions(screen.getByLabelText('插件管理对象'), 'user:1')
  return user
}
it('ignores a late old target and never mounts a stopped runtime', async () => {
  const pending = Promise.withResolvers<api.PluginManagementTarget>()
  vi.mocked(api.pluginManagementTarget).mockImplementation((kind, id, _signal, runtimeId) => kind === 'user' ? pending.promise : Promise.resolve({ ...target, target: { kind, id, runtimeId }, generation: null }))
  render(<PluginsPage />)
  const user = await chooseUser()
  const signal = vi.mocked(api.pluginManagementTarget).mock.calls[0]![2]!
  await user.selectOptions(screen.getByLabelText('插件管理对象'), 'project:7')
  expect(signal.aborted).toBe(true)
  expect((await screen.findAllByText(/实例未运行/)).length).toBeGreaterThan(0)
  await act(async () => { pending.resolve(target); await pending.promise })
  expect(pluginManagementRemote).not.toHaveBeenCalled()
})
it('shows the selected owner qualification inside the management-object section', async () => {
  render(<PluginsPage />)
  await chooseUser()
  await waitFor(() => expect(api.getPluginPolicy).toHaveBeenCalledWith('user', 1, expect.anything()))
  expect(await screen.findByText('已授权')).toBeTruthy()
  expect(screen.getByText('允许此用户在个人空间管理插件')).toBeTruthy()
})
it('removes the active workflow and aborts its stream when authorization is revoked', async () => {
  render(<PluginsPage />)
  const user = await chooseUser()
  await user.click(await screen.findByRole('button', { name: '添加插件' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  const calls = vi.mocked(pluginManagementRemote).mock.calls
  // The matrix and the live manager each own a remote; only the page's binding-clearing callback removes the workflow.
  act(() => { calls.forEach(call => call[3]?.('管理权限已撤销')) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: '添加插件' })).toBeNull()
  expect(calls.every(call => call[1].aborted)).toBe(true)
  expect(screen.getByText('管理权限已撤销')).toBeTruthy()
})
it('aborts the previous workflow on a scope switch and aborts the next on unmount', async () => {
  const view = render(<PluginsPage />)
  const user = await chooseUser()
  await screen.findByRole('button', { name: '添加插件' })
  const firstSignals = vi.mocked(pluginManagementRemote).mock.calls.map(call => call[1])
  await user.selectOptions(screen.getByLabelText('插件管理对象'), 'project:7')
  await waitFor(() => expect(vi.mocked(pluginManagementRemote).mock.calls.length).toBeGreaterThan(firstSignals.length))
  expect(firstSignals.every(signal => signal.aborted)).toBe(true)
  const last = vi.mocked(pluginManagementRemote).mock.calls.at(-1)!
  expect(last[0].target).toEqual({ kind: 'project', id: 7, runtimeId: runtimeFixture('project', 7).id })
  view.unmount()
  expect(vi.mocked(pluginManagementRemote).mock.calls.every(call => call[1].aborted)).toBe(true)
})
it('shares one startup draft between the folded matrix and the save bar', async () => {
  vi.mocked(api.pluginManagementSaveState).mockResolvedValue({ ...stateView, revision: '3' })
  render(<PluginsPage />)
  await chooseUser()
  // The entry-level matrix folds behind the advanced summary; the lifecycle line leads the section.
  expect(document.querySelector('details.pluginAdvanced > summary')?.textContent).toContain('高级：组成视图')
  expect(screen.getByText(/插件的生命周期/)).toBeTruthy()
  await waitFor(() => expect(screen.getByLabelText('启动时启用 core')).toBeTruthy())
  // A startup edit on the matrix raises the shared draft bar the friendly list writes to as well.
  fireEvent.click(screen.getByLabelText('启动时启用 core'))
  await waitFor(() => expect(screen.getByText('启动时 · 1 项变更待保存')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '放弃修改' }))
  await waitFor(() => expect(screen.queryByText(/项变更待保存/)).toBeNull())
  fireEvent.click(screen.getByLabelText('启动时启用 core'))
  await waitFor(() => expect(screen.getByText('启动时 · 1 项变更待保存')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: '保存插件组成' }))
  await waitFor(() => expect(api.pluginManagementSaveState).toHaveBeenCalledWith(
    { target: { kind: 'user', id: 1, runtimeId: runtimeFixture('user', 1).id }, revision: '2', state: { entries: [], bundles: [] } }))
  await waitFor(() => expect(screen.queryByText(/项变更待保存/)).toBeNull())
})
it('rejects a different target before exposing any management action', async () => {
  vi.mocked(api.pluginManagementTarget).mockResolvedValue({ ...target, target: { kind: 'project', id: 7 } })
  render(<PluginsPage />)
  await chooseUser()
  expect(await screen.findByText(/实例与所选范围不一致/)).toBeTruthy()
  expect(pluginManagementRemote).not.toHaveBeenCalled()
})

const livePlugin = (patchId: string, enabled = true): PluginInfo => ({
  entryId: `include:${patchId}` as PluginInfo['entryId'], patchId,
  moduleName: `dsh-${patchId}`, enabled, fiberPhase: 'active',
})
const catalogAnswer = (plugins: PluginInfo[] = []) => ({
  ok: true as const,
  value: { managementAvailable: true, manage: true, plugins, bundles: [] } satisfies PluginManagementCatalog,
})
function pendingCatalog() {
  const pending = Promise.withResolvers<Awaited<ReturnType<PluginManagementRemote['pluginManager']['catalog']>>>()
  onTestFinished(async () => {
    pending.resolve({ ok: false, error: { code: 'fixture-disposed', message: 'fixture disposed' } })
    await pending.promise
  })
  return pending
}

it('shares one admitted catalog with the advanced matrix without legacy reads or an idle refresh', async () => {
  const pending = pendingCatalog()
  vi.mocked(remoteFixture.pluginManager.catalog).mockReturnValueOnce(pending.promise)
  render(<PluginsPage />)
  await chooseUser()
  await waitFor(() => expect(remoteFixture.pluginManager.catalog).toHaveBeenCalledTimes(1))
  expect({
    state: vi.mocked(api.pluginManagementState).mock.calls.length,
    catalog: vi.mocked(remoteFixture.pluginManager.catalog).mock.calls.length,
    legacyPlugins: vi.mocked(remoteFixture.pluginManager.listPlugins).mock.calls.length,
    legacyBundles: vi.mocked(remoteFixture.pluginManager.listBundles).mock.calls.length,
  }).toEqual({ state: 1, catalog: 1, legacyPlugins: 0, legacyBundles: 0 })
  expect(remoteFixture.settings.describe).not.toHaveBeenCalled()
  await act(async () => { pending.resolve(catalogAnswer([livePlugin('catalog-entry')])); await pending.promise })
  expect(await screen.findByLabelText('当前启用 catalog-entry')).toBeTruthy()
  await waitFor(() => expect(remoteFixture.settings.describe).toHaveBeenCalledTimes(1))
  expect(api.pluginManagementState).toHaveBeenCalledTimes(1)
  expect(remoteFixture.pluginManager.listPlugins).not.toHaveBeenCalled()
  expect(remoteFixture.pluginManager.listBundles).not.toHaveBeenCalled()
})

it('refreshes the shared catalog and startup state after an advanced live write', async () => {
  vi.mocked(remoteFixture.pluginManager.catalog).mockResolvedValueOnce(catalogAnswer([livePlugin('advanced')]))
    .mockResolvedValue(catalogAnswer([livePlugin('advanced', false)]))
  vi.mocked(remoteFixture.pluginManager.setPluginEnabled).mockResolvedValue({
    ok: true, value: { changed: true, application: 'applied', stage: 'enable', target: 'advanced' },
  })
  render(<PluginsPage />)
  await chooseUser()
  fireEvent.click(await screen.findByLabelText('当前启用 advanced'))
  await waitFor(() => expect(remoteFixture.pluginManager.setPluginEnabled).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(remoteFixture.pluginManager.catalog).toHaveBeenCalledTimes(2))
  expect(screen.getByLabelText('当前启用 advanced')).toHaveProperty('checked', false)
  expect(api.pluginManagementState).toHaveBeenCalledTimes(2)
  expect(remoteFixture.pluginManager.listPlugins).not.toHaveBeenCalled()
  expect(remoteFixture.pluginManager.listBundles).not.toHaveBeenCalled()
})

it('ignores an old catalog after a target switch even when the old request succeeds late', async () => {
  const old = pendingCatalog()
  vi.mocked(remoteFixture.pluginManager.catalog).mockReturnValueOnce(old.promise)
    .mockResolvedValue(catalogAnswer([livePlugin('new-target')]))
  render(<PluginsPage />)
  const user = await chooseUser()
  await waitFor(() => expect(remoteFixture.pluginManager.catalog).toHaveBeenCalledTimes(1))
  const oldSignal = vi.mocked(remoteFixture.pluginManager.catalog).mock.calls[0]![1]!
  await user.selectOptions(screen.getByLabelText('插件管理对象'), 'project:7')
  expect(await screen.findByLabelText('当前启用 new-target')).toBeTruthy()
  expect(oldSignal.aborted).toBe(true)
  await act(async () => { old.resolve(catalogAnswer([livePlugin('old-target')])); await old.promise })
  expect(screen.queryByLabelText('当前启用 old-target')).toBeNull()
  expect(screen.getByLabelText('当前启用 new-target')).toBeTruthy()
  expect(remoteFixture.pluginManager.listPlugins).not.toHaveBeenCalled()
})

it('drops a late admitted catalog after unmount or revoked authorization', async () => {
  const old = pendingCatalog()
  vi.mocked(remoteFixture.pluginManager.catalog).mockReturnValueOnce(old.promise)
  const page = render(<PluginsPage />)
  await chooseUser()
  await waitFor(() => expect(remoteFixture.pluginManager.catalog).toHaveBeenCalledTimes(1))
  act(() => { vi.mocked(pluginManagementRemote).mock.calls.forEach(call => call[3]('403 denied')) })
  expect(screen.getByText('403 denied')).toBeTruthy()
  const signal = vi.mocked(remoteFixture.pluginManager.catalog).mock.calls[0]![1]!
  expect(signal.aborted).toBe(true)
  page.unmount()
  await act(async () => { old.resolve(catalogAnswer([livePlugin('revoked')])); await old.promise })
  expect(remoteFixture.settings.describe).not.toHaveBeenCalled()
  expect(document.querySelector('[data-plugin-panel]')).toBeNull()
})

it('retries a failed catalog on focus without legacy reads', async () => {
  vi.mocked(remoteFixture.pluginManager.catalog).mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: 'offline' } })
    .mockResolvedValue(catalogAnswer([livePlugin('retry')]))
  render(<PluginsPage />)
  await chooseUser()
  await waitFor(() => expect(remoteFixture.pluginManager.catalog).toHaveBeenCalledTimes(1))
  fireEvent.focus(window)
  expect(await screen.findByLabelText('当前启用 retry')).toBeTruthy()
  expect(remoteFixture.pluginManager.listPlugins).not.toHaveBeenCalled()
  expect(remoteFixture.pluginManager.listBundles).not.toHaveBeenCalled()
})

it('uses a fresh active catalog lifetime after StrictMode cleanup and aborts it on unmount', async () => {
  vi.mocked(remoteFixture.pluginManager.catalog).mockResolvedValue(catalogAnswer([livePlugin('strict-owner')]))
  const page = render(<StrictMode><PluginsPage /></StrictMode>)
  await chooseUser()
  expect(await screen.findByLabelText('当前启用 strict-owner')).toBeTruthy()
  const current = vi.mocked(remoteFixture.pluginManager.catalog).mock.calls.at(-1)![1]!
  expect(current.aborted).toBe(false)
  expect(remoteFixture.pluginManager.listPlugins).not.toHaveBeenCalled()
  expect(remoteFixture.pluginManager.listBundles).not.toHaveBeenCalled()
  page.unmount()
  expect(vi.mocked(remoteFixture.pluginManager.catalog).mock.calls.every(([, signal]) => signal?.aborted)).toBe(true)
})

it('does not refresh either owner from a previous target write that settles late', async () => {
  const applied = { ok: true as const, value: { changed: true, application: 'applied' as const, stage: 'enable' as const, target: 'previous' } }
  const write = Promise.withResolvers<typeof applied>()
  onTestFinished(async () => { write.resolve(applied); await write.promise })
  vi.mocked(remoteFixture.pluginManager.setPluginEnabled).mockReturnValueOnce(write.promise)
  vi.mocked(remoteFixture.pluginManager.catalog).mockResolvedValueOnce(catalogAnswer([livePlugin('previous')]))
    .mockResolvedValue(catalogAnswer([livePlugin('replacement')]))
  render(<PluginsPage />)
  const user = await chooseUser()
  fireEvent.click(await screen.findByLabelText('当前启用 previous'))
  await waitFor(() => expect(remoteFixture.pluginManager.setPluginEnabled).toHaveBeenCalledTimes(1))
  await user.selectOptions(screen.getByLabelText('插件管理对象'), 'project:7')
  expect(await screen.findByLabelText('当前启用 replacement')).toBeTruthy()
  await act(async () => { write.resolve(applied); await write.promise })
  expect(remoteFixture.pluginManager.catalog).toHaveBeenCalledTimes(2)
  expect(api.pluginManagementState).toHaveBeenCalledTimes(2)
  expect(screen.queryByLabelText('当前启用 previous')).toBeNull()
})

it('keeps the post-write state when the initial state request answers late', async () => {
  const initial = Promise.withResolvers<api.PluginManagementState>()
  onTestFinished(async () => { initial.resolve(stateView); await initial.promise })
  vi.mocked(api.pluginManagementState).mockReturnValueOnce(initial.promise)
    .mockResolvedValue({ ...stateView, revision: '7', appliedRevision: '7' })
  vi.mocked(remoteFixture.pluginManager.catalog).mockResolvedValue({ ok: true, value: {
    managementAvailable: true, manage: true, plugins: [], bundles: [{
      name: 'state-race', installed: true, optional: false, enabled: true, removable: true, rows: [], overrides: [],
    }],
  } })
  vi.mocked(remoteFixture.pluginManager.setBundleEnabled).mockResolvedValue({
    ok: true, value: { changed: true, application: 'applied', stage: 'enable', target: 'state-race' },
  })
  render(<PluginsPage />)
  await chooseUser()
  fireEvent.click(await screen.findByLabelText('启用 state-race'))
  expect(await screen.findByText(/已存启动配置 · 版本 7/)).toBeTruthy()
  expect(api.pluginManagementState).toHaveBeenCalledTimes(2)
  await act(async () => { initial.resolve(stateView); await initial.promise })
  expect(screen.getByText(/已存启动配置 · 版本 7/)).toBeTruthy()
  expect(screen.queryByText(/已存启动配置 · 版本 2/)).toBeNull()
})
