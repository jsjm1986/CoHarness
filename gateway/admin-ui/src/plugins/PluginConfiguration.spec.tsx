/** Real configuration forms preserve secret values and concurrent administrator edits. */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { PluginConfiguration } from './PluginConfiguration.tsx'
import { ProfileSettingsController } from './settings-store.ts'
import type { ProfileSettingsRemote } from './transport.ts'
import type { SettingsNamespaceView } from '../../../../packages/host/apiproxy/src/api/settings.ts'

afterEach(cleanup)
const view: SettingsNamespaceView = {
  ns: 'fixture', revision: 3, owner: 'deployment', writable: true, applies: 'restart',
  schema: Schema.object({ capacity: Schema.number().min(1).step(1).default(2), enabled: Schema.boolean().default(false),
    endpoint: Schema.string().description('请求地址'), secret: Schema.string().role('secret'), routes: Schema.array(Schema.string()) }).toJSON(),
  value: { capacity: 3, enabled: false, endpoint: 'https://example.test', routes: ['one'] },
  base: { capacity: 2 }, user: { capacity: 3 }, secrets: [{ path: ['secret'], set: true }],
}
function fixture() {
  const remote: ProfileSettingsRemote = { describe: vi.fn(async () => ({ ok: true as const, value: { writable: true, hasDocument: false, namespaces: [view] } })),
    mutate: vi.fn(async () => ({ ok: true as const, value: { ...view, revision: 4 } })) }
  const controller = new ProfileSettingsController(remote)
  return { remote, controller }
}
it('saves changed fields only, preserves untouched secrets and distinguishes restart application', async () => {
  const { controller, remote } = fixture(), user = userEvent.setup()
  render(<PluginConfiguration view={view} controller={controller} />)
  expect(screen.getByText('已配置；不显示原值。')).toBeTruthy()
  expect(screen.queryByLabelText('secret 新凭据')).toBeNull()
  await user.clear(screen.getByLabelText('capacity'))
  await user.type(screen.getByLabelText('capacity'), '4')
  await user.click(screen.getByRole('button', { name: '保存配置' }))
  await screen.findByText('配置已保存，重启实例后生效。')
  expect(remote.mutate).toHaveBeenCalledExactlyOnceWith({ ns: 'fixture', expectedRevision: 3, ops: [{ op: 'set', path: ['capacity'], value: 4 }] })
})
it('rejects invalid fields, uses explicit credential operations and restores inheritance with unset', async () => {
  const { controller, remote } = fixture(), user = userEvent.setup()
  render(<PluginConfiguration view={view} controller={controller} />)
  await user.selectOptions(screen.getByLabelText('secret 凭据操作'), 'set')
  expect((screen.getByRole('button', { name: '保存配置' }) as HTMLButtonElement).disabled).toBe(true)
  await user.type(screen.getByLabelText('secret 新凭据'), 'fixture-replacement')
  await user.clear(screen.getByLabelText('routes'))
  await user.type(screen.getByLabelText('routes'), 'invalid-json')
  expect((screen.getByRole('button', { name: '保存配置' }) as HTMLButtonElement).disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: '恢复继承：routes' }))
  await user.click(screen.getByRole('button', { name: '恢复继承：capacity' }))
  await user.click(screen.getByRole('button', { name: '保存配置' }))
  await waitFor(() => expect(remote.mutate).toHaveBeenCalledOnce())
  expect(vi.mocked(remote.mutate).mock.calls[0]![0].ops).toEqual([
    { op: 'unset', path: ['capacity'] }, { op: 'set', path: ['secret'], value: 'fixture-replacement' }, { op: 'unset', path: ['routes'] },
  ])
})
it('retains drafts on refusal and refuses to save them over a newer revision', async () => {
  const { controller, remote } = fixture(), user = userEvent.setup()
  vi.mocked(remote.mutate).mockResolvedValueOnce({ ok: false, error: { code: 'settings-rejected', message: 'configuration refused' } })
  const rendered = render(<PluginConfiguration view={view} controller={controller} />)
  await user.clear(screen.getByLabelText('endpoint'))
  await user.type(screen.getByLabelText('endpoint'), 'https://new.test')
  await user.click(screen.getByRole('button', { name: '保存配置' }))
  await screen.findByText('configuration refused')
  expect((screen.getByLabelText('endpoint') as HTMLInputElement).value).toBe('https://new.test')
  rendered.rerender(<PluginConfiguration view={{ ...view, revision: 4, value: { ...view.value as object, endpoint: 'https://elsewhere.test' } }} controller={controller} />)
  expect(screen.getByText(/配置已在其他位置更新/)).toBeTruthy()
  expect((screen.getByRole('button', { name: '保存配置' }) as HTMLButtonElement).disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: '放弃草稿' }))
  expect((screen.getByLabelText('endpoint') as HTMLInputElement).value).toBe('https://elsewhere.test')
})
it('keeps a redacted secret inside an array while editing its adjacent visible field', async () => {
  const { controller, remote } = fixture(), user = userEvent.setup()
  const nested: SettingsNamespaceView = { ...view,
    schema: Schema.object({ peers: Schema.array(Schema.object({ name: Schema.string(), token: Schema.string().role('secret') })) }).toJSON(),
    value: { peers: [{ name: 'first' }] }, secrets: [{ path: ['peers', '0', 'token'], set: true }],
  }
  render(<PluginConfiguration view={nested} controller={controller} />)
  await user.clear(screen.getByLabelText('peers / 0 / name'))
  await user.type(screen.getByLabelText('peers / 0 / name'), 'changed')
  await user.click(screen.getByRole('button', { name: '保存配置' }))
  expect(remote.mutate).toHaveBeenCalledWith({ ns: 'fixture', expectedRevision: 3, ops: [{ op: 'set', path: ['peers', '0', 'name'], value: 'changed' }] })
})
