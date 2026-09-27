/** Scope changes discard private workflow state before the next runtime can answer. */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { pluginManagementRemote } from '../plugins/transport.ts'
import { PluginsPage } from './PluginsPage.tsx'

vi.mock('../api.ts', () => ({ listUsers: vi.fn(), listProjects: vi.fn(), pluginManagementTarget: vi.fn() }))
vi.mock('../plugins/transport.ts', () => ({ pluginManagementRemote: vi.fn() }))
afterEach(cleanup)
const target: api.PluginManagementTarget = { nodeId: 'node-a', target: { kind: 'user', id: 1 }, generation: 3 }
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.listUsers).mockResolvedValue([{ id: 1, displayName: 'Alice' } as api.AdminUser])
  vi.mocked(api.listProjects).mockResolvedValue([{ id: 7, name: 'Shared' } as api.Project])
  vi.mocked(api.pluginManagementTarget).mockImplementation(async (kind, id) => ({ ...target, target: { kind, id } }))
  const unused = vi.fn(async () => { throw new Error('unexpected mutation') })
  vi.mocked(pluginManagementRemote).mockReturnValue({
    settings: { describe: vi.fn(async () => ({ ok: true as const, value: { writable: true, hasDocument: false, namespaces: [] } })), mutate: unused },
    pluginInventory: { list: vi.fn(async () => ({ ok: true as const, value: { managementAvailable: true, entries: [] } })) },
    pluginManager: {
      listPlugins: vi.fn(async () => ({ ok: true as const, value: [] })),
      listBundles: vi.fn(async () => ({ ok: true as const, value: [] })),
      inspect: unused, setPluginEnabled: unused, setBundleEnabled: unused,
      installBundle: unused, cancelInstall: unused, removeBundle: unused,
    },
  })
})
async function chooseUser() {
  const user = userEvent.setup()
  await waitFor(() => expect(screen.getByLabelText('插件运行范围').querySelector('option[value="user:1"]')).toBeTruthy())
  await user.selectOptions(screen.getByLabelText('插件运行范围'), 'user:1')
  return user
}
it('ignores a late old target and never mounts a stopped runtime', async () => {
  const pending = Promise.withResolvers<api.PluginManagementTarget>()
  vi.mocked(api.pluginManagementTarget).mockImplementation((kind, id) => kind === 'user' ? pending.promise : Promise.resolve({ ...target, target: { kind, id }, generation: null }))
  render(<PluginsPage />)
  const user = await chooseUser()
  const signal = vi.mocked(api.pluginManagementTarget).mock.calls[0]![2]!
  await user.selectOptions(screen.getByLabelText('插件运行范围'), 'project:7')
  expect(signal.aborted).toBe(true)
  expect(await screen.findByText(/实例未运行/)).toBeTruthy()
  await act(async () => { pending.resolve(target); await pending.promise })
  expect(pluginManagementRemote).not.toHaveBeenCalled()
})
it('removes the active workflow and aborts its stream when authorization is revoked', async () => {
  render(<PluginsPage />)
  const user = await chooseUser()
  await user.click(await screen.findByRole('button', { name: '添加插件' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  const [, signal, , invalidate] = vi.mocked(pluginManagementRemote).mock.calls[0]!
  act(() => invalidate('管理权限已撤销'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: '添加插件' })).toBeNull()
  expect(signal.aborted).toBe(true)
  expect(screen.getByText('管理权限已撤销')).toBeTruthy()
})
it('aborts the previous workflow on a scope switch and aborts the next on unmount', async () => {
  const view = render(<PluginsPage />)
  const user = await chooseUser()
  await screen.findByRole('button', { name: '添加插件' })
  const first = vi.mocked(pluginManagementRemote).mock.calls[0]![1]
  await user.selectOptions(screen.getByLabelText('插件运行范围'), 'project:7')
  await waitFor(() => expect(pluginManagementRemote).toHaveBeenCalledTimes(2))
  expect(first.aborted).toBe(true)
  expect(vi.mocked(pluginManagementRemote).mock.calls[1]![0].target).toEqual({ kind: 'project', id: 7 })
  view.unmount()
  expect(vi.mocked(pluginManagementRemote).mock.calls[1]![1].aborted).toBe(true)
})
it('rejects a different target before exposing any management action', async () => {
  vi.mocked(api.pluginManagementTarget).mockResolvedValue({ ...target, target: { kind: 'project', id: 7 } })
  render(<PluginsPage />)
  await chooseUser()
  expect(await screen.findByText(/实例与所选范围不一致/)).toBeTruthy()
  expect(pluginManagementRemote).not.toHaveBeenCalled()
})
