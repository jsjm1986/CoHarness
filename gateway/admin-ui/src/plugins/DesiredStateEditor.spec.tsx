import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminRequestError, type PluginManagementState } from '../api.ts'
import { DesiredStateEditor } from './DesiredStateEditor.tsx'

vi.mock('../api.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api.ts')>()
  return {
    ...original,
    pluginManagementState: vi.fn(),
    pluginManagementSaveState: vi.fn(),
  }
})
const api = vi.mocked(await import('../api.ts'))

beforeEach(() => { vi.clearAllMocks() })
afterEach(cleanup)

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

describe('DesiredStateEditor', () => {
  it('renders the saved composition for a stopped instance and saves edits under its revision', async () => {
    api.pluginManagementState.mockResolvedValue(view())
    api.pluginManagementSaveState.mockImplementation(async input => view({ revision: '4', state: input.state }))
    render(<DesiredStateEditor kind="user" id={7} />)
    await waitFor(() => expect(screen.getByText(/期望状态版本 3/)).toBeTruthy())
    expect(screen.getByText(/实例未运行，将于下次启动时应用/)).toBeTruthy()
    expect(api.pluginManagementState).toHaveBeenCalledWith('user', 7, expect.anything())
    // The saved bundle is checked; an observed-only name joins the choices unchecked.
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes.map(box => (box.closest('label')?.textContent ?? ''))).toContain('observed-only')
    // Disable one saved bundle.
    fireEvent.click(boxes.find(box => box.closest('label')?.textContent === 'extra')!)
    fireEvent.click(screen.getByRole('button', { name: '保存期望状态' }))
    await waitFor(() => expect(screen.getByText(/期望状态版本 4/)).toBeTruthy())
    expect(api.pluginManagementSaveState).toHaveBeenCalledWith(
      { target: { kind: 'user', id: 7 }, revision: '3', state: { entries: [{ id: 'managed', disabled: true }], bundles: ['core'] } })
  })

  it('creates the draft from the observed files when no state exists', async () => {
    api.pluginManagementState.mockResolvedValue(view({ revision: '0', state: null, appliedRevision: '0' }))
    api.pluginManagementSaveState.mockResolvedValue(view({ revision: '1' }))
    render(<DesiredStateEditor kind="project" id={9} />)
    await waitFor(() => expect(screen.getByText(/尚无期望状态/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '从文件现状创建' }))
    fireEvent.click(screen.getByRole('button', { name: '保存期望状态' }))
    await waitFor(() => expect(api.pluginManagementSaveState).toHaveBeenCalledWith(
      { target: { kind: 'project', id: 9 }, revision: '0',
        state: { entries: [], bundles: ['core', 'extra', 'observed-only'] } }))
  })

  it('reloads and resets the draft when the save conflicts', async () => {
    api.pluginManagementState.mockResolvedValue(view())
    api.pluginManagementSaveState.mockRejectedValue(new AdminRequestError(409, 'plugin state changed'))
    api.pluginManagementState.mockResolvedValueOnce(view())
      .mockResolvedValue(view({ revision: '6', state: { entries: [], bundles: ['core'] } }))
    render(<DesiredStateEditor kind="user" id={7} />)
    await waitFor(() => expect(screen.getByText(/期望状态版本 3/)).toBeTruthy())
    const boxes = screen.getAllByRole('checkbox')
    fireEvent.click(boxes.find(box => box.closest('label')?.textContent === 'extra')!)
    fireEvent.click(screen.getByRole('button', { name: '保存期望状态' }))
    await waitFor(() => expect(screen.getByText(/并发冲突/)).toBeTruthy())
    expect(screen.getByText(/期望状态版本 6/)).toBeTruthy()
    expect(api.pluginManagementState).toHaveBeenCalledTimes(2)
  })

  it('clears the saved state', async () => {
    api.pluginManagementState.mockResolvedValue(view())
    api.pluginManagementSaveState.mockResolvedValue(view({ revision: '0', state: null, appliedRevision: '0' }))
    render(<DesiredStateEditor kind="user" id={7} />)
    await waitFor(() => expect(screen.getByText(/期望状态版本 3/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '清除期望状态' }))
    await waitFor(() => expect(api.pluginManagementSaveState).toHaveBeenCalledWith(
      { target: { kind: 'user', id: 7 }, revision: '3', state: null }))
  })
})
