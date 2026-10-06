/** Webhook form failures remain readable inside the modal that owns the draft. */
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { createWebhookEndpoint, listUsers, listProjects } from '../api.ts'
import { WebhooksPage } from './WebhooksPage.tsx'

vi.mock('../api.ts', () => ({
  listWebhookEndpoints: vi.fn(async () => ({ endpoints: [] })),
  listUsers: vi.fn(async () => []),
  listProjects: vi.fn(async () => []),
  createWebhookEndpoint: vi.fn(),
  updateWebhookEndpoint: vi.fn(),
  mutateWebhookEndpoint: vi.fn(),
  listWebhookDeliveries: vi.fn(),
  redispatchWebhookDelivery: vi.fn(),
}))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('shows missing execution-account feedback without closing or clearing the registration draft', async () => {
  const user = userEvent.setup()
  render(<WebhooksPage />)
  await screen.findByText('尚无 Webhook 端点')
  await user.click(screen.getByRole('button', { name: '注册端点' }))
  const dialog = screen.getByRole('dialog', { name: '注册 Webhook 端点' })
  const name = within(dialog).getByLabelText('名称', { exact: false })
  await user.type(name, 'Draft endpoint')
  await user.click(within(dialog).getByRole('button', { name: '保存' }))
  expect((await within(dialog).findByRole('alert')).textContent).toContain('必须选择执行账号')
  expect((name as HTMLInputElement).value).toBe('Draft endpoint')
  expect(createWebhookEndpoint).not.toHaveBeenCalled()
})

it.each(['project', 'private'] as const)('submits an explicit %s visibility for a project endpoint', async (visibility) => {
  vi.mocked(listUsers).mockResolvedValue([
    { id: 12, username: 'executor', status: 'active' },
    { id: 13, username: 'retired', status: 'disabled' },
  ] as Awaited<ReturnType<typeof listUsers>>)
  vi.mocked(listProjects).mockResolvedValue([{ id: 8, name: 'Shared' }] as Awaited<ReturnType<typeof listProjects>>)
  const user = userEvent.setup()
  render(<WebhooksPage />)
  await screen.findByText('尚无 Webhook 端点')
  await user.click(screen.getByRole('button', { name: '注册端点' }))
  const dialog = within(screen.getByRole('dialog', { name: '注册 Webhook 端点' }))
  const accountSelector = dialog.getByRole('combobox', { name: /^执行账号/ }) as HTMLSelectElement
  expect([...accountSelector.options].map(option => option.text)).not.toContain('retired')
  expect(dialog.queryByLabelText('新会话可见性', { exact: false })).toBeNull()
  await user.selectOptions(dialog.getByLabelText('运行时类型'), 'project')
  const selector = dialog.getByLabelText('新会话可见性', { exact: false }) as HTMLSelectElement
  expect(selector.value).toBe('project')
  await user.selectOptions(selector, visibility)
  await user.selectOptions(accountSelector, '12')
  await user.selectOptions(dialog.getByLabelText('目标运行时', { exact: false }), '8')
  await user.type(dialog.getByLabelText('名称', { exact: false }), 'Project deliveries')
  await user.type(dialog.getByLabelText('提示词模板', { exact: false }), 'Summarize {{event.name}}')
  await user.type(dialog.getByLabelText('工作区路径', { exact: false }), '/srv/workspaces/shared')
  await user.type(dialog.getByLabelText('代理预设', { exact: false }), 'default')
  await user.type(dialog.getByLabelText('权限预设', { exact: false }), 'standard')
  await user.type(dialog.getByLabelText('签名密钥', { exact: false }), 'fixture-signing-secret')
  await user.click(dialog.getByRole('button', { name: '保存' }))
  expect(createWebhookEndpoint).toHaveBeenCalledWith(expect.objectContaining({
    runtimeKind: 'project', runtimePublicId: 8, executionUserId: 12, projectVisibility: visibility,
  }))
})
