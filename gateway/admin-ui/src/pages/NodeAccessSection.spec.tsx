/** Node onboarding keeps secrets local, revisions explicit and unknown outcomes visible. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nodeAccessEntrySchema, nodeEnrollmentSchema } from '../../../src/node-access.ts'
import * as api from '../api.ts'
import { NodeAccessSection } from './NodeAccessSection.tsx'

vi.mock('../api.ts', async original => ({
  ...await original<typeof api>(), listNodeAccess: vi.fn(), issueNodeEnrollment: vi.fn(), reissueNodeEnrollment: vi.fn(), revokeNodeAccess: vi.fn(), listDeploymentCandidates: vi.fn(), detachNodeAccess: vi.fn(),
}))

const node = nodeAccessEntrySchema.parse({ nodeId: '61f22202-1c02-4a3c-8d34-f11222333444', name: '设计电脑', revision: 2,
  status: 'connected', platform: 'darwin', architecture: 'arm64', lastSeenAt: '2026-10-28T10:00:00.000Z', leaseExpiresAt: '2026-10-28T10:00:30.000Z', executionReady: false })
const receipt = nodeEnrollmentSchema.parse({ nodeId: node.nodeId, enrollmentId: '10111111-1111-4111-8111-111111111111', revision: 1,
  token: `dsh_enroll_${'A'.repeat(43)}`, expiresAt: '2026-10-28T11:00:00.000Z' })
let storageValues: Map<string, string>
const releases: Array<() => void> = []
beforeEach(() => {
  vi.resetAllMocks()
  storageValues = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storageValues.get(key) ?? null,
    setItem: (key: string, value: string) => { storageValues.set(key, value) },
    removeItem: (key: string) => { storageValues.delete(key) },
    clear: () => { storageValues.clear() },
    key: (index: number) => [...storageValues.keys()][index] ?? null,
    get length() { return storageValues.size },
  })
  localStorage.setItem('coharness-admin-language', 'zh')
  vi.mocked(api.listDeploymentCandidates).mockResolvedValue({ items: [], nextCursor: null })
  vi.mocked(api.listNodeAccess).mockResolvedValue({ items: [node], nextCursor: null })
  vi.mocked(api.issueNodeEnrollment).mockImplementation(async (_name, requestId) => ({ ...receipt, enrollmentId: requestId }))
})
afterEach(() => {
  cleanup()
  for (const release of releases.splice(0).reverse()) release()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function add() {
  fireEvent.click(screen.getByRole('button', { name: '添加电脑' }))
  const dialog = screen.getByRole('dialog', { name: '添加电脑' })
  fireEvent.change(within(dialog).getByLabelText('电脑名称'), { target: { value: '测试电脑' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '签发接入码' }))
  return dialog
}

it('allows onboarding independently of a pending directory read and shows connection separately from execution', async () => {
  const waiting = deferred<api.NodeAccessPage>()
  vi.mocked(api.listNodeAccess).mockReturnValueOnce(waiting.promise)
  render(<NodeAccessSection />)
  expect(screen.getByText('正在读取电脑列表')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '添加电脑' }))
  expect(screen.getByRole('dialog', { name: '添加电脑' })).not.toBeNull()
  expect(screen.getByText('在新电脑部署同一版本，接入后配置用户的电脑权限和 Runtime。添加电脑后，完整部署备份和恢复会因多节点覆盖不足而暂时不可用。')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  await act(async () => { waiting.resolve({ items: [node], nextCursor: null }) })
  expect(screen.getByText('已连接', { exact: true })).not.toBeNull()
  expect(screen.getByText(/完成部署、电脑授权与 Runtime 配置后/)).not.toBeNull()
  expect(screen.queryByRole('button', { name: '运行任务' })).toBeNull()
})

it('validates the name, masks a one-time code and removes it when its dialog closes', async () => {
  const copy = vi.fn().mockResolvedValue(undefined)
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
  releases.push(() => { if (previous === undefined) Reflect.deleteProperty(navigator, 'clipboard'); else Object.defineProperty(navigator, 'clipboard', previous) })
  render(<NodeAccessSection />)
  await screen.findByText(node.name, { exact: true })
  fireEvent.click(screen.getByRole('button', { name: '添加电脑' }))
  const form = screen.getByRole('dialog', { name: '添加电脑' })
  fireEvent.change(within(form).getByLabelText('电脑名称'), { target: { value: '/invalid' } })
  fireEvent.click(within(form).getByRole('button', { name: '签发接入码' }))
  expect(within(form).getByText('请填写符合规则的电脑名称。')).not.toBeNull()
  expect(api.issueNodeEnrollment).not.toHaveBeenCalled()
  fireEvent.change(within(form).getByLabelText('电脑名称'), { target: { value: '测试电脑' } })
  fireEvent.click(within(form).getByRole('button', { name: '签发接入码' }))
  const ticket = await screen.findByRole('dialog', { name: '测试电脑的一次性接入码' })
  expect((within(ticket).getByLabelText('接入码', { exact: true }) as HTMLInputElement).type).toBe('password')
  expect(api.issueNodeEnrollment).toHaveBeenCalledExactlyOnceWith('测试电脑', expect.any(String))
  fireEvent.click(within(ticket).getByRole('button', { name: '复制接入码' }))
  expect(await within(ticket).findByText('接入码已复制')).not.toBeNull()
  expect(copy).toHaveBeenCalledExactlyOnceWith(receipt.token)
  fireEvent.click(within(ticket).getByRole('button', { name: '显示接入码' }))
  expect((within(ticket).getByLabelText('接入码', { exact: true }) as HTMLInputElement).type).toBe('text')
  fireEvent.click(within(ticket).getByRole('button', { name: '完成' }))
  expect(screen.queryByLabelText('接入码', { exact: true })).toBeNull()
  expect([...storageValues.values()].some(value => value.includes(receipt.token))).toBe(false)
})

it('keeps a stale-revision refusal in the confirmation and never substitutes the refreshed revision', async () => {
  vi.mocked(api.reissueNodeEnrollment).mockRejectedValue(new api.AdminRequestError(409, 'node-access/revision-conflict'))
  render(<NodeAccessSection />)
  await screen.findByText(node.name, { exact: true })
  fireEvent.click(screen.getByRole('button', { name: '重新签发' }))
  const dialog = screen.getByRole('dialog', { name: '为 设计电脑 重新签发接入码' })
  expect(api.reissueNodeEnrollment).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '签发接入码' }))
  expect(await within(dialog).findByText('该电脑的接入信息已变化。请关闭窗口，刷新列表后再操作。')).not.toBeNull()
  expect(api.reissueNodeEnrollment).toHaveBeenCalledExactlyOnceWith(node, expect.any(String))
  expect(screen.getByText(node.name, { exact: true })).not.toBeNull()
  expect(screen.queryByLabelText('接入码', { exact: true })).toBeNull()
})

it('explains active connections using the retained code after the API localizes its message', async () => {
  vi.mocked(api.detachNodeAccess).mockRejectedValue(new api.AdminRequestError(409, '所选电脑正在忙，请稍后重试', 'node-service/busy'))
  render(<NodeAccessSection />)
  await screen.findByText(node.name, { exact: true })
  fireEvent.click(screen.getByRole('button', { name: '退出接入' }))
  const dialog = screen.getByRole('dialog', { name: '让 设计电脑 退出接入' })
  fireEvent.click(within(dialog).getByRole('button', { name: '退出接入' }))
  expect(await within(dialog).findByText(/关闭这台电脑的工作台/)).not.toBeNull()
  expect(screen.getByText(node.name, { exact: true })).not.toBeNull()
  expect(api.detachNodeAccess).toHaveBeenCalledExactlyOnceWith(node)
})

it('preserves an uncertain issuance, blocks another submission and refreshes metadata for explicit recovery', async () => {
  vi.mocked(api.issueNodeEnrollment).mockRejectedValue(new TypeError('network failed'))
  render(<NodeAccessSection />)
  await screen.findByText(node.name, { exact: true })
  const dialog = await add()
  expect(await within(dialog).findByText(/无法确认操作是否已完成/)).not.toBeNull()
  expect(within(dialog).queryByRole('button', { name: '签发接入码' })).toBeNull()
  expect((within(dialog).getByLabelText('电脑名称') as HTMLInputElement).disabled).toBe(true)
  fireEvent.keyDown(within(dialog).getByLabelText('电脑名称'), { key: 'Enter' })
  expect(api.issueNodeEnrollment).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(api.listNodeAccess).toHaveBeenCalledTimes(2))
})

it('retains rows on read failure and navigates bounded pages without loading all computers', async () => {
  const nextNode = { ...node, nodeId: '67f22202-1c02-4a3c-8d34-f11222333444' as typeof node.nodeId, name: '另一台电脑' }
  vi.mocked(api.listNodeAccess).mockResolvedValueOnce({ items: [node], nextCursor: node.nodeId })
    .mockResolvedValueOnce({ items: [nextNode], nextCursor: null }).mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ items: [node], nextCursor: node.nodeId })
  render(<NodeAccessSection />)
  await screen.findByText(node.name, { exact: true })
  expect(api.listNodeAccess).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByText(nextNode.name, { exact: true })
  expect(api.listNodeAccess).toHaveBeenLastCalledWith(node.nodeId, expect.any(AbortSignal))
  fireEvent.click(screen.getByRole('button', { name: '刷新电脑列表' }))
  expect(await screen.findByText('未能读取电脑列表。已有信息仍保留，请重新读取。')).not.toBeNull()
  expect(screen.getByText(nextNode.name, { exact: true })).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '返回首页' }))
  await screen.findByText(node.name, { exact: true })
  expect(api.listNodeAccess).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal))
})

it('clears cached rows and a one-time code when directory authority is revoked', async () => {
  render(<NodeAccessSection />)
  await screen.findByText(node.name, { exact: true })
  await add()
  await screen.findByRole('dialog', { name: '测试电脑的一次性接入码' })
  vi.mocked(api.listNodeAccess).mockRejectedValue(new api.AdminRequestError(403, 'node-access/forbidden'))
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(await screen.findByText('当前账号没有此操作的权限。请重新登录或联系组织管理员。')).not.toBeNull()
  expect(screen.queryByLabelText('接入码', { exact: true })).toBeNull()
  expect(screen.queryByText(node.name, { exact: true })).toBeNull()
})

it('keeps polling single-flight and cancels its own request on unmount', async () => {
  vi.useFakeTimers()
  const waiting = deferred<api.NodeAccessPage>()
  vi.mocked(api.listNodeAccess).mockReturnValue(waiting.promise)
  const view = render(<NodeAccessSection />)
  const signal = vi.mocked(api.listNodeAccess).mock.calls[0]![1]!
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(api.listNodeAccess).toHaveBeenCalledTimes(1)
  view.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => { waiting.resolve({ items: [node], nextCursor: null }) })
})

it('renders the same access states and recovery actions in English', async () => {
  localStorage.setItem('coharness-admin-language', 'en')
  render(<NodeAccessSection />)
  await screen.findByText('Connected', { exact: true })
  fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }))
  expect(screen.getByRole('dialog', { name: `Revoke access for ${node.name}` })).not.toBeNull()
  expect(screen.getByText('This computer will no longer be able to connect to the center. You can reissue a code to restore access.')).not.toBeNull()
})
