/** Admin configuration keeps edits, actual values and explicit restart requests distinct. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NODE_CONFIG_FIELDS } from '../../../src/node-config-fields.ts'
import * as api from '../api.ts'
import { NodeConfigurationSection } from './NodeConfigurationSection.tsx'

vi.mock('../api.ts', () => ({ getNodeConfiguration: vi.fn(), mutateNodeConfiguration: vi.fn() }))
const values = Object.fromEntries(NODE_CONFIG_FIELDS.map(field => [field.key, field.kind === 'integer' ? '8899' : `/private/${field.key}`])) as api.NodeSettingValues
const initial: api.NodeConfigurationView = { organizationId: 'org', nodeId: 'node', revision: 0, appliedRevision: 0, runningRevision: 0,
  desired: values, effective: values, operation: null, configFile: '/private/config.json' }
beforeEach(() => { vi.resetAllMocks(); vi.mocked(api.getNodeConfiguration).mockResolvedValue(structuredClone(initial)) })
afterEach(() => { cleanup() })

it('saves a node-bound revision without restarting and keeps the effective value visible', async () => {
  const changed = { ...values, HGW_PORT: '9330' }
  vi.mocked(api.mutateNodeConfiguration).mockResolvedValue({ ...initial, revision: 1, desired: changed })
  render(<NodeConfigurationSection />)
  const port = await screen.findByLabelText('Gateway 端口（1–65535）')
  fireEvent.change(port, { target: { value: '9330' } })
  fireEvent.click(screen.getByRole('button', { name: '保存待应用配置' }))
  await waitFor(() => expect(api.mutateNodeConfiguration).toHaveBeenCalledWith({ action: 'save', organizationId: 'org', nodeId: 'node', revision: 0, values: changed }))
  expect(await screen.findByText('已保存待应用配置；当前进程仍使用原值。')).not.toBeNull()
  expect(screen.getAllByText(/当前生效：8899/).length).toBeGreaterThan(0)
  expect(api.mutateNodeConfiguration).toHaveBeenCalledTimes(1)
})

it('requires explicit impact confirmation and keeps an apply error inside the open dialog', async () => {
  vi.mocked(api.getNodeConfiguration).mockResolvedValue({ ...initial, revision: 1, desired: { ...values, HGW_PORT: '9330' } })
  vi.mocked(api.mutateNodeConfiguration).mockRejectedValue(new Error('配置版本已变化'))
  render(<NodeConfigurationSection />)
  fireEvent.click(await screen.findByRole('button', { name: '应用并重启' }))
  const dialog = screen.getByRole('dialog', { name: '应用节点配置并重启' })
  expect(api.mutateNodeConfiguration).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '确认应用并重启' }))
  expect(await within(dialog).findByText('配置版本已变化')).not.toBeNull()
  expect(api.mutateNodeConfiguration).toHaveBeenCalledWith({ action: 'apply', organizationId: 'org', nodeId: 'node', revision: 1 })
})

it('retains a conflicted draft until the administrator explicitly reloads', async () => {
  vi.mocked(api.mutateNodeConfiguration).mockRejectedValue(new Error('配置版本已变化'))
  render(<NodeConfigurationSection />)
  const port = await screen.findByLabelText('Gateway 端口（1–65535）')
  fireEvent.change(port, { target: { value: '9401' } })
  fireEvent.click(screen.getByRole('button', { name: '保存待应用配置' }))
  expect(await screen.findByText('配置版本已变化')).not.toBeNull()
  expect((port as HTMLInputElement).value).toBe('9401')
  vi.mocked(api.getNodeConfiguration).mockResolvedValue({ ...initial, revision: 2, desired: { ...values, HGW_PORT: '9402' } })
  fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
  await waitFor(() => expect((port as HTMLInputElement).value).toBe('9402'))
})
