/** The cross-space inventory lists every space's reported composition, with a saved-state fallback. */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { translatePlugin } from './presentation.ts'
import { SpacesInventory } from './SpacesInventory.tsx'

vi.mock('../api.ts', () => ({ pluginInventoryList: vi.fn(async () => []) }))
vi.mock('../language.ts', () => ({ adminLanguage: () => 'zh' }))

afterEach(() => { cleanup() })

const t = translatePlugin('zh')
const userSpace: api.PluginInventorySpaceRow = {
  target: { kind: 'user', id: 1, label: 'owner', steward: false },
  live: true, generation: 3, reportedAt: '2026-11-17T06:00:00.000Z',
  inventory: {
    bundles: [{
      name: '@team/collab-plugins', version: '1.3.0',
      meta: { title: { en: 'Collab tools', zh: '协作工具' } },
      enabled: true, installed: true, optional: false, removable: true,
      source: 'file:/home/owner/plugins/collab',
      rows: [{ rowId: 'rows', moduleName: '@team/collab-plugins/rows', entryId: 'entry-1' }],
      overrides: [],
    }, {
      name: '@deepseek-ai/dsh-web', version: '2.0.0', enabled: true,
      installed: false, optional: false, removable: false, rows: [], overrides: [],
    }],
    plugins: [
      { entryId: 'entry-1', moduleName: '@team/collab-plugins/rows', enabled: true, fiberPhase: 'active' },
      { entryId: 'entry-2', moduleName: 'cordis:manager', enabled: true, fiberPhase: 'active' },
      { entryId: 'entry-3', moduleName: 'broken/plugin', enabled: true, fiberPhase: 'failed' },
    ],
  },
  desired: null,
}
const savedOnlySpace: api.PluginInventorySpaceRow = {
  target: { kind: 'project', id: 7, label: 'Shared', steward: false },
  live: false, generation: null, reportedAt: null, inventory: null,
  desired: { entries: [{ id: 'row-one', name: '@deepseek-ai/dsh-web', disabled: false }], bundles: ['@deepseek-ai/dsh-base'] },
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.pluginInventoryList).mockResolvedValue([userSpace, savedOnlySpace])
})

it('lists every space with its reported composition summary and saved-state fallback', async () => {
  render(<SpacesInventory t={t} onPick={() => {}} />)
  await waitFor(() => expect(screen.getByText('owner')).toBeTruthy())
  expect(screen.getByText('2 个包 · 3 条目 · 1 异常')).toBeTruthy()
  expect(screen.getByText('Shared')).toBeTruthy()
  expect(screen.getAllByText(/保存的组合/).length).toBeGreaterThan(0)
})

it('expands a space to show bundle install sources and live row phases', async () => {
  const user = userEvent.setup()
  render(<SpacesInventory t={t} onPick={() => {}} />)
  const summary = await screen.findByText('owner')
  await user.click(summary)
  expect(screen.getByText('协作工具')).toBeTruthy()
  expect(screen.getByText('@1.3.0')).toBeTruthy()
  expect(screen.getAllByText('本地').length).toBeGreaterThan(0)
  expect(screen.getAllByText('@deepseek-ai/dsh-web').length).toBeGreaterThan(0)
  expect(screen.getAllByText('内置').length).toBeGreaterThan(0)
  await user.click(screen.getByText('运行时条目（3）'))
  expect(screen.getByText('broken/plugin')).toBeTruthy()
})

it('filters spaces by label, bundle name, localized title, or module name', async () => {
  const user = userEvent.setup()
  render(<SpacesInventory t={t} onPick={() => {}} />)
  await waitFor(() => expect(screen.getByText('owner')).toBeTruthy())
  await user.type(screen.getByLabelText('筛选空间或插件…'), 'collab')
  expect(screen.getByText('owner')).toBeTruthy()
  expect(screen.queryByText('Shared')).toBeNull()
  await user.clear(screen.getByLabelText('筛选空间或插件…'))
  await user.type(screen.getByLabelText('筛选空间或插件…'), '协作')
  expect(screen.getByText('owner')).toBeTruthy()
  expect(screen.queryByText('Shared')).toBeNull()
  await user.clear(screen.getByLabelText('筛选空间或插件…'))
  await user.type(screen.getByLabelText('筛选空间或插件…'), 'nothing-matches')
  expect(screen.getByText('没有匹配的空间或插件。')).toBeTruthy()
})

it('binds the target picker through the manage action without expanding the card', async () => {
  const user = userEvent.setup()
  const picks: string[] = []
  render(<SpacesInventory t={t} onPick={key => picks.push(key)} />)
  await waitFor(() => expect(screen.getByText('owner')).toBeTruthy())
  const disclosure = screen.getByRole('button', { name: /owner/u })
  await user.click(screen.getAllByText('管理')[0]!)
  expect(picks).toEqual(['user:1'])
  expect(disclosure.getAttribute('aria-expanded')).toBe('false')
})
