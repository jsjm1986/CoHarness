/** The shared composition edits the draft and drives live switches; the matrix view renders its columns. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminRequestError, type PluginManagementState, type PluginManagementTarget } from '../api.ts'
import type { PluginInfo } from '../../../../packages/boot/plugin-manager/src/types.ts'
import { pluginManagementRemote } from './transport.ts'
import { PluginMatrix } from './PluginMatrix.tsx'
import { usePluginComposition } from './composition.ts'

vi.mock('../api.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api.ts')>()
  return {
    ...original,
    pluginManagementState: vi.fn(),
    pluginManagementSaveState: vi.fn(),
  }
})
vi.mock('./transport.ts', () => ({ pluginManagementRemote: vi.fn() }))
const api = vi.mocked(await import('../api.ts'))
const remote = vi.mocked(pluginManagementRemote)

beforeEach(() => { vi.clearAllMocks() })
afterEach(cleanup)

const stopped: PluginManagementTarget = { nodeId: 'node-a', target: { kind: 'user', id: 7 }, generation: null }
const running: PluginManagementTarget = { ...stopped, generation: 3 }

function view(overrides: Partial<PluginManagementState> = {}): PluginManagementState {
  return {
    revision: '3',
    state: { entries: [{ id: 'managed', disabled: true }], bundles: ['core', 'extra'] },
    appliedRevision: '3',
    generation: null,
    observed: { entries: [], bundles: ['core', 'extra', 'observed-only'] },
    ...overrides,
  }
}

function liveRemote(plugins: PluginInfo[] = []) {
  const calls = {
    listPlugins: vi.fn(async () => ({ ok: true as const, value: plugins })),
    listBundles: vi.fn(async () => ({ ok: true as const, value: [] })),
    setPluginEnabled: vi.fn(async () => ({ ok: true as const, value: { changed: true, application: 'applied' } })),
    setBundleEnabled: vi.fn(async () => ({ ok: true as const, value: { changed: true, application: 'applied' } })),
  }
  remote.mockReturnValue({ pluginManager: calls } as never)
  return calls
}

const plugin = (patchId: string, enabled: boolean, title?: string): PluginInfo => ({
  entryId: `include:${patchId}` as PluginInfo['entryId'],
  moduleName: `mod-${patchId}`,
  patchId,
  enabled,
  fiberPhase: 'active',
  meta: title === undefined ? undefined : { title },
})

/** The page arrangement under test: the matrix over the shared composition, its error and notice, and the draft actions. */
function Harness({ kind, id, target }: { kind: 'user' | 'project'; id: number; target: PluginManagementTarget }) {
  const composition = usePluginComposition(kind, id, target)
  return <>
    {composition.error === '' ? null : <p role="alert">{composition.error}</p>}
    {composition.notice === '' ? null : <p role="status">{composition.notice}</p>}
    {composition.dirty
      ? <>
        <button onClick={() => { void composition.save(composition.draft) }}>保存插件组成</button>
        <button onClick={() => { composition.discard() }}>放弃修改</button>
      </>
      : null}
    <PluginMatrix composition={composition} />
    {composition.persist && composition.view?.state != null
      ? <button onClick={() => { void composition.save(null) }}>清除启动配置</button>
      : null}
  </>
}

describe('PluginMatrix', () => {
  it('renders observed and desired columns for a stopped instance and saves edits under its revision', async () => {
    api.pluginManagementState.mockResolvedValue(view())
    api.pluginManagementSaveState.mockImplementation(async input => view({ revision: '4', state: input.state }))
    render(<Harness kind="user" id={7} target={stopped} />)
    await waitFor(() => expect(screen.getByText(/已存启动配置 · 版本 3/)).toBeTruthy())
    expect(screen.getByText(/将于下次启动应用/)).toBeTruthy()
    expect(remote).not.toHaveBeenCalled()
    // The managed row shows its saved position; the observed-only bundle joins the list.
    expect(screen.getByLabelText('启动时 managed')).toHaveProperty('value', 'off')
    expect(screen.getByLabelText('启动时启用 observed-only')).toBeTruthy()
    // Enable the managed entry at startup: observed off → desired on, so the row flags the change.
    fireEvent.change(screen.getByLabelText('启动时 managed'), { target: { value: 'on' } })
    expect(screen.getByText('将变更')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存插件组成' }))
    await waitFor(() => expect(api.pluginManagementSaveState).toHaveBeenCalledWith(
      { target: { kind: 'user', id: 7 }, revision: '3',
        state: { entries: [{ id: 'managed', disabled: false }], bundles: ['core', 'extra'] } }))
    await waitFor(() => expect(screen.getByText(/已存启动配置 · 版本 4/)).toBeTruthy())
  })

  it('materializes the draft from the current composition when nothing is saved', async () => {
    api.pluginManagementState.mockResolvedValue(view({ revision: '0', state: null, appliedRevision: '0' }))
    api.pluginManagementSaveState.mockResolvedValue(view({ revision: '1' }))
    render(<Harness kind="project" id={9} target={{ ...stopped, target: { kind: 'project', id: 9 } }} />)
    await waitFor(() => expect(screen.getByText(/尚无保存的启动配置/)).toBeTruthy())
    // Disabling a bundle drafts the whole current selection, never an empty list.
    fireEvent.click(screen.getByLabelText('启动时启用 observed-only'))
    fireEvent.click(screen.getByRole('button', { name: '保存插件组成' }))
    await waitFor(() => expect(api.pluginManagementSaveState).toHaveBeenCalledWith(
      { target: { kind: 'project', id: 9 }, revision: '0',
        state: { entries: [], bundles: ['core', 'extra'] } }))
  })

  it('reloads and resets the draft when the save conflicts', async () => {
    api.pluginManagementState.mockResolvedValue(view())
    api.pluginManagementSaveState.mockRejectedValue(new AdminRequestError(409, 'plugin state changed'))
    api.pluginManagementState.mockResolvedValueOnce(view())
      .mockResolvedValue(view({ revision: '6', state: { entries: [], bundles: ['core'] } }))
    render(<Harness kind="user" id={7} target={stopped} />)
    await waitFor(() => expect(screen.getByText(/已存启动配置 · 版本 3/)).toBeTruthy())
    fireEvent.click(screen.getByLabelText('启动时启用 extra'))
    fireEvent.click(screen.getByRole('button', { name: '保存插件组成' }))
    await waitFor(() => expect(screen.getByText(/并发修改/)).toBeTruthy())
    expect(screen.getByText(/已存启动配置 · 版本 6/)).toBeTruthy()
    expect(api.pluginManagementState).toHaveBeenCalledTimes(2)
  })

  it('clears the saved state', async () => {
    api.pluginManagementState.mockResolvedValue(view())
    api.pluginManagementSaveState.mockResolvedValue(view({ revision: '0', state: null, appliedRevision: '0' }))
    render(<Harness kind="user" id={7} target={stopped} />)
    await waitFor(() => expect(screen.getByText(/已存启动配置 · 版本 3/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '清除启动配置' }))
    await waitFor(() => expect(api.pluginManagementSaveState).toHaveBeenCalledWith(
      { target: { kind: 'user', id: 7 }, revision: '3', state: null }))
  })

  it('applies a live switch through the instance and resyncs the saved column', async () => {
    const calls = liveRemote([plugin('llm', true, '语言模型'), plugin('managed', false)])
    api.pluginManagementState.mockResolvedValue(view())
    api.pluginManagementState.mockResolvedValueOnce(view())
      .mockResolvedValue(view({ revision: '4', appliedRevision: '4', generation: 3 }))
    render(<Harness kind="user" id={7} target={running} />)
    await waitFor(() => expect(screen.getByText('语言模型')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('当前启用 llm'))
    await waitFor(() => expect(calls.setPluginEnabled).toHaveBeenCalledWith('include:llm', false))
    await waitFor(() => expect(api.pluginManagementState).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/写回插件组成/)).toBeTruthy()
  })

  it('degrades to live-only switches when the deployment has no state store', async () => {
    const calls = liveRemote([plugin('llm', true)])
    api.pluginManagementState.mockRejectedValue(new AdminRequestError(503, 'plugin state store unavailable'))
    render(<Harness kind="user" id={7} target={running} />)
    await waitFor(() => expect(screen.getByText(/未启用启动配置存储/)).toBeTruthy())
    await waitFor(() => expect(screen.getByLabelText('当前启用 llm')).toBeTruthy())
    // The startup column and the saved-state controls stay out; live switches still fire.
    expect(screen.queryByLabelText('启动时 llm')).toBeNull()
    expect(screen.queryByRole('button', { name: '保存插件组成' })).toBeNull()
    fireEvent.click(screen.getByLabelText('当前启用 llm'))
    await waitFor(() => expect(calls.setPluginEnabled).toHaveBeenCalledWith('include:llm', false))
    await waitFor(() => expect(screen.getByText(/实例已应用改动/)).toBeTruthy())
  })

  it('keeps managed rows visible but unmounted when the live inventory skips them', async () => {
    liveRemote([plugin('other', true)])
    api.pluginManagementState.mockResolvedValue(view())
    render(<Harness kind="user" id={7} target={running} />)
    await waitFor(() => expect(screen.getByLabelText('当前启用 other')).toBeTruthy())
    // The saved entry has no live row: static observed text, still editable at startup.
    expect(screen.queryByLabelText('当前启用 managed')).toBeNull()
    expect(screen.getByText(/未装载/)).toBeTruthy()
    expect(screen.getByLabelText('启动时 managed')).toHaveProperty('value', 'off')
  })

  it('renders the English dictionary when the persisted language is en', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'coharness-admin-language' ? 'en' : null,
      setItem: () => {},
      removeItem: () => {},
    })
    api.pluginManagementState.mockResolvedValue(view())
    render(<Harness kind="user" id={7} target={stopped} />)
    await waitFor(() => expect(screen.getByText(/Saved startup configuration · revision 3/)).toBeTruthy())
    expect(screen.getByText(/applies at the next start/)).toBeTruthy()
    expect(screen.getByLabelText('managed at startup')).toHaveProperty('value', 'off')
    vi.unstubAllGlobals()
  })
})
