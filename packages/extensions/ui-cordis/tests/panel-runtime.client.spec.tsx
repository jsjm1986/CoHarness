// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { RuntimeEnvironments, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { CordisPendingApproval, CordisRunActivity } from '@deepseek-ai/dsh-cordis-client-runner/client'
import { CordisPanel } from '../src/client/CordisPanel.tsx'
import type { CordisPanelActions } from '../src/client/slots.ts'
import type { CordisDynamicPluginId, CordisDynamicPackageId, ApprovalRequestId } from '../src/client/events.ts'
import type { CordisInventorySnapshot } from '../src/client/inventory.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const a = 'a-conversation' as SessionId, b = 'b-conversation' as SessionId
const pluginId = 'same-plugin' as CordisDynamicPluginId, requestId = 'same-request' as ApprovalRequestId

function scope(sessionId: SessionId, name: string, key: string) {
  const inventory = createSnapshotStore<CordisInventorySnapshot>({ rows: [], removed: new Set(), read: true })
  const activities = createSnapshotStore<ReadonlyMap<CordisDynamicPluginId, CordisRunActivity>>(new Map([[pluginId, {
    phase: 'awaiting-approval', requestId, agentId: sessionId, packageId: 'package' as CordisDynamicPackageId,
    mode: 'run', name, purpose: 'Runtime-owned approval',
  }]]))
  const actions: CordisPanelActions = { runtimeKey: key, computerName: name,
    onApprove: vi.fn(async () => {}), onDecline: vi.fn(async () => {}), onRun: vi.fn(async () => {}),
    onStop: vi.fn(async () => ({ ok: true as const })), onRemove: vi.fn(async () => ({ ok: true as const })), onRefresh: vi.fn() }
  return { inventory, activities, actions, useInventory: bindSnapshotSelector(inventory),
    useActiveRuns: bindSnapshotSelector(activities) }
}

function mount() {
  const first = scope(a, 'Mac configuration', 'base'), second = scope(b, 'Ubuntu configuration', 'remote-b')
  const sessions = createSnapshotStore({ current: a })
  const pending = createSnapshotStore<readonly CordisPendingApproval[]>([])
  const environments = createSnapshotStore<RuntimeEnvironments>({ showComputer: true, status: 'ready',
    choices: [{ key: 'base', name: 'Mac configuration', available: true }] })
  const source = (key?: string) => key === b ? second : first
  const value = <T,>(snapshot: T) => <Selected,>(_key: string, select: (value: T) => Selected) => select(snapshot)
  const props = {
    wide: true, useSessions: bindSnapshotSelector(sessions), usePendingApprovals: bindSnapshotSelector(pending),
    useRuntimeEnvironments: bindSnapshotSelector(environments),
    useInventory: (key, select) => source(key).useInventory(select),
    useActiveRuns: (key, select) => source(key).useActiveRuns(select),
    useRunErrors: value(new Map()), useRenderFailures: value(new Map()), useLoaded: value([]),
    actionsForSession: (id?: SessionId) => source(id).actions, t: makeTranslate(zh, {}),
  } as Parameters<typeof CordisPanel>[0]
  render(<CordisPanel {...props} />)
  return { first, second, sessions, environments, pending }
}

it('keeps an open panel and its actions on the captured Runtime while the conversation changes', async () => {
  const h = mount()
  const trigger = screen.getByRole('button', { name: 'Cordis 插件' })
  fireEvent.click(trigger)
  let panel = screen.getByRole('region', { name: 'Cordis 插件' })
  expect(within(panel).getAllByText('Mac configuration')).toHaveLength(2)
  act(() => { h.sessions.set({ current: b }) })
  expect(within(panel).queryByText('Ubuntu configuration')).toBeNull()
  fireEvent.click(within(panel).getByRole('button', { name: '仅允许此版本' }))
  await act(async () => {})
  expect(h.first.actions.onApprove).toHaveBeenCalledExactlyOnceWith(requestId, false)
  expect(h.second.actions.onApprove).not.toHaveBeenCalled()
  fireEvent.click(trigger)
  panel = screen.getByRole('region', { name: 'Cordis 插件' })
  expect(within(panel).getAllByText('Ubuntu configuration')).toHaveLength(2)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('region')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it('does not close a different Runtime panel when an earlier approval finishes', async () => {
  const h = mount(), answer = Promise.withResolvers<undefined>()
  vi.mocked(h.first.actions.onApprove).mockReturnValue(answer.promise)
  const trigger = screen.getByRole('button', { name: 'Cordis 插件' })
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: '仅允许此版本' }))
  fireEvent.click(trigger)
  act(() => { h.sessions.set({ current: b }) })
  fireEvent.click(trigger)
  await act(async () => { answer.resolve(undefined) })
  expect(within(screen.getByRole('region', { name: 'Cordis 插件' })).getAllByText('Ubuntu configuration')).toHaveLength(2)
  expect(h.second.actions.onApprove).not.toHaveBeenCalled()
  act(() => { h.environments.set({ ...h.environments.getSnapshot(), showComputer: false }) })
  expect(within(screen.getByRole('region')).getAllByText('Ubuntu configuration')).toHaveLength(1)
})

it('keeps failed reads visible and retries the same Runtime after its directory access disappears', () => {
  const h = mount()
  act(() => { h.sessions.set({ current: b }); h.second.inventory.set({ rows: [], removed: new Set(), read: false, error: 'Access revoked' }) })
  fireEvent.click(screen.getByRole('button', { name: 'Cordis 插件' }))
  expect(screen.getByRole('alert').textContent).toContain('Access revoked')
  const before = vi.mocked(h.second.actions.onRefresh).mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: zh['action.retry'] }))
  expect(h.second.actions.onRefresh).toHaveBeenCalledTimes(before + 1)
  expect(h.first.actions.onApprove).not.toHaveBeenCalled()
})
