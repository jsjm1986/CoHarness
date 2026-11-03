/** Mode edits use ingress policy, keep unsaved input and inspect detach blockers before committing. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { DeploymentContextProvider } from '../deployment-context.tsx'
import { DeploymentTopologySection } from './DeploymentTopologySection.tsx'
import { deploymentContextSchema } from '../../../src/deployment-protocol.ts'

vi.mock('../api.ts', async original => ({ ...await original<typeof api>(),
  getDeploymentTopology: vi.fn(), saveDeploymentTopology: vi.fn(), preflightDeploymentTopology: vi.fn(),
}))
const single = deploymentContextSchema.parse({ mode: 'single', revision: '0',
  entry: { nodeId: '10000000-0000-4000-8000-000000000001', name: 'A' }, primary: null,
  scope: 'local', role: 'standalone', refreshAfterMs: 30000, legacyMigrationRequired: false })
const multi = deploymentContextSchema.parse({ ...single, mode: 'multi', revision: '1', scope: 'organization', role: 'primary',
  primary: { ...single.entry, origin: 'https://primary.test' } })
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('localStorage', { getItem: () => 'zh' })
  vi.mocked(api.getDeploymentTopology).mockResolvedValue(single)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const open = () => render(<DeploymentContextProvider><DeploymentTopologySection /></DeploymentContextProvider>)

it('rereads a committed mode when repeated invalidations arrive during an older policy request', async () => {
  let release!: (value: typeof single) => void
  vi.mocked(api.getDeploymentTopology).mockReturnValueOnce(new Promise(resolve => { release = resolve })).mockResolvedValue(multi)
  open()
  await act(async () => {
    window.dispatchEvent(new Event('hgw-deployment-policy-changed'))
    window.dispatchEvent(new Event('hgw-deployment-policy-changed'))
    release(single)
  })
  await waitFor(() => expect((screen.getByRole('checkbox', { name: '启用多电脑' }) as HTMLInputElement).checked).toBe(true))
  expect(api.getDeploymentTopology).toHaveBeenCalledTimes(2)
})

it('keeps the configured primary address and compares the displayed revision when enabling', async () => {
  open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '启用多电脑' }))
  fireEvent.change(screen.getByLabelText('主入口访问地址'), { target: { value: 'https://primary.test' } })
  vi.mocked(api.saveDeploymentTopology).mockResolvedValue(multi)
  vi.mocked(api.getDeploymentTopology).mockResolvedValue(multi)
  fireEvent.click(screen.getByRole('button', { name: '保存部署模式' }))
  await screen.findByText('部署模式已保存')
  expect(api.saveDeploymentTopology).toHaveBeenCalledExactlyOnceWith({ revision: '0', enabled: true, primaryOrigin: 'https://primary.test' })
})

it('keeps a dirty address through cross-tab invalidation and refreshes the revision only on explicit reload', async () => {
  open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '启用多电脑' }))
  fireEvent.change(screen.getByLabelText('主入口访问地址'), { target: { value: 'https://draft.test' } })
  vi.mocked(api.getDeploymentTopology).mockResolvedValue(multi)
  await act(async () => { window.dispatchEvent(new Event('hgw-deployment-policy-changed')) })
  expect((screen.getByLabelText('主入口访问地址') as HTMLInputElement).value).toBe('https://draft.test')
  vi.mocked(api.saveDeploymentTopology).mockRejectedValueOnce(new api.AdminRequestError(409, '配置已变化', 'deployment/revision-conflict'))
  fireEvent.click(screen.getByRole('button', { name: '保存部署模式' }))
  expect((await screen.findByRole('alert')).textContent).toContain('部署设置已变化，未保存的输入仍保留，请重新读取后核对')
  expect(api.saveDeploymentTopology).toHaveBeenCalledWith({ revision: '0', enabled: true, primaryOrigin: 'https://draft.test' })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新读取' })) })
  vi.mocked(api.saveDeploymentTopology).mockResolvedValue({ ...multi, revision: '2' })
  fireEvent.click(screen.getByRole('button', { name: '保存部署模式' }))
  await waitFor(() => expect(api.saveDeploymentTopology).toHaveBeenLastCalledWith({ revision: '1', enabled: true, primaryOrigin: 'https://draft.test' }))
})

it('does not disable while a disconnected computer remains attached', async () => {
  vi.mocked(api.getDeploymentTopology).mockResolvedValue(multi)
  vi.mocked(api.preflightDeploymentTopology).mockResolvedValue({ canDisable: false, blockingCount: 1,
    computers: [{ nodeId: single.entry.nodeId, name: 'Offline B', state: 'managed', activeRuntimes: 1 }] })
  open()
  fireEvent.click(await screen.findByRole('checkbox', { name: '启用多电脑' }))
  fireEvent.click(screen.getByRole('button', { name: '保存部署模式' }))
  await screen.findByText(/Offline B/)
  expect(api.saveDeploymentTopology).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('makes a secondary entry local and directs mode changes to the primary in a separate tab', async () => {
  vi.mocked(api.getDeploymentTopology).mockResolvedValue({ ...multi, role: 'computer', scope: 'local', entry: {
    nodeId: '10000000-0000-4000-8000-000000000002' as typeof single.entry.nodeId, name: 'B' } })
  open()
  const link = await screen.findByRole('link', { name: '在新标签页打开主入口管理' })
  expect(link.getAttribute('href')).toBe('https://primary.test/admin/deployment')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(screen.queryByRole('checkbox')).toBeNull()
})
