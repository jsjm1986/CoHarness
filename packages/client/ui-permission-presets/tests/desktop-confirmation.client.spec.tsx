// @vitest-environment jsdom
/** Exact-pane desktop gestures and stale reply suppression. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle, DesktopConfirmation, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { DesktopConfirmationAction, type DesktopConfirmationProps } from '../src/client/DesktopConfirmationAction.tsx'
import { desktopEn } from '../src/client/desktop-locales.ts'

afterEach(cleanup)
const ok = <T,>(value: T) => ({ rpcId: 'r' as never, result: { ok: true as const, value } })
function fixture() {
  const value: DesktopConfirmation = { rootSessionId: 'root' as SessionId, nodeId: 'node', desktop: 'display-0', userId: 12,
    eligible: true, confirmed: false, occupancy: { available: true, inUse: false, heldByThisSession: false, queued: 0 } }
  const status = vi.fn<ConnectionHandle['api']['desktop']['status']>().mockResolvedValue(ok(value))
  const confirm = vi.fn<ConnectionHandle['api']['desktop']['confirm']>().mockImplementation(async payload => ok({ ...value, confirmed: payload.confirmed }))
  const state = createSnapshotStore<'connected' | 'reconnecting' | undefined>('connected')
  const host = createSnapshotStore<{ executionAuthorityRequired: boolean } | undefined>({ executionAuthorityRequired: true })
  const connection = { api: { desktop: { status, confirm } }, state, hostDescription: host } as unknown as ConnectionHandle
  const props = { sessionId: 'pane' as SessionId, connection, t: (key: keyof typeof desktopEn) => desktopEn[key] } as DesktopConfirmationProps
  return { value, status, confirm, state, host, props }
}

it('shows the exact target and saves only explicit confirmation and withdrawal gestures', async () => {
  const f = fixture()
  render(<DesktopConfirmationAction {...f.props} />)
  // The trigger's status dot reads eagerly at mount; opening still refreshes.
  await waitFor(() => { expect(f.status).toHaveBeenCalledOnce() })
  fireEvent.click(screen.getByRole('button', { name: /Desktop access/ }))
  await screen.findByText('display-0')
  expect(screen.getByText('root')).toBeTruthy()
  expect(screen.getByText('node')).toBeTruthy()
  expect(f.confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: desktopEn.confirm }))
  await screen.findByText(desktopEn.granted)
  expect(f.confirm).toHaveBeenCalledWith({ sessionId: 'pane', rootSessionId: 'root', nodeId: 'node', desktop: 'display-0', confirmed: true }, expect.any(AbortSignal))
  fireEvent.click(screen.getByRole('button', { name: desktopEn.withdraw }))
  await screen.findByText(desktopEn.unconfirmed)
  expect(f.confirm.mock.calls[1]![0].confirmed).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: desktopEn.close }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
})

it('hides the action in independent local profiles and explains unconfigured managed profiles', async () => {
  const f = fixture()
  f.host.set({ executionAuthorityRequired: false })
  const view = render(<DesktopConfirmationAction {...f.props} />)
  expect(screen.queryByRole('button')).toBeNull()
  f.status.mockResolvedValue(ok(null))
  act(() => { f.host.set({ executionAuthorityRequired: true }) })
  fireEvent.click(screen.getByRole('button', { name: /Desktop access/ }))
  await screen.findByText(desktopEn.unavailable)
  expect(screen.queryByRole('button', { name: desktopEn.confirm })).toBeNull()
  view.unmount()
})

it('disables confirmation for an ineligible account', async () => {
  const f = fixture()
  f.status.mockResolvedValue(ok({ ...f.value, eligible: false }))
  render(<DesktopConfirmationAction {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: /Desktop access/ }))
  await screen.findByText(desktopEn.ineligible)
  expect(screen.getByRole('button', { name: desktopEn.confirm })).toHaveProperty('disabled', true)
  expect(f.confirm).not.toHaveBeenCalled()
})

it('clears sensitive target state on disconnect and reloads after reconnection', async () => {
  const f = fixture()
  render(<DesktopConfirmationAction {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: /Desktop access/ }))
  await screen.findByText('display-0')
  act(() => { f.state.set('reconnecting') })
  await screen.findByText(desktopEn.disconnected)
  expect(screen.queryByText('node')).toBeNull()
  act(() => { f.state.set('connected') })
  await screen.findByText('display-0')
  // Mount read + open refresh + reconnect read.
  expect(f.status).toHaveBeenCalledTimes(3)
})

it.each([true, false])('discards a delayed read after the pane changes runtime (resolves=%s)', async (resolves) => {
  const first = fixture(), second = fixture(), reply = Promise.withResolvers<ReturnType<typeof ok<DesktopConfirmation>>>()
  first.status.mockReturnValueOnce(reply.promise)
  second.status.mockResolvedValue(ok({ ...second.value, desktop: 'display-new' }))
  const view = render(<DesktopConfirmationAction {...first.props} />)
  // The eager mount read is the delayed reply this case hangs.
  await waitFor(() => { expect(first.status).toHaveBeenCalledOnce() })
  const oldSignal = first.status.mock.calls[0]![1]!
  view.rerender(<DesktopConfirmationAction {...second.props} sessionId={'second-pane' as SessionId} />)
  await waitFor(() => { expect(second.status).toHaveBeenCalled() })
  expect(oldSignal.aborted).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: /Desktop access/ }))
  await screen.findByText('display-new')
  await act(async () => { if (resolves) reply.resolve(ok(first.value)); else reply.reject(new Error('cancelled')); await reply.promise.catch(() => undefined) })
  expect(screen.queryByText('display-0')).toBeNull()
})

it('shows read failures, retries, and requires a fresh read after a rejected save', async () => {
  const f = fixture()
  // Mount read fails; the open-triggered refresh fails too, so the dialog
  // still surfaces the read alert the case exercises.
  f.status.mockResolvedValueOnce({ rpcId: 'r' as never, result: { ok: false, error: { code: 'internal', message: 'denied', details: {} } } })
  f.status.mockResolvedValueOnce({ rpcId: 'r' as never, result: { ok: false, error: { code: 'internal', message: 'denied', details: {} } } })
  render(<DesktopConfirmationAction {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: /Desktop access/ }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: desktopEn.refresh }))
  await screen.findByText('display-0')
  f.confirm.mockResolvedValueOnce({ rpcId: 'r' as never, result: { ok: false, error: { code: 'internal', message: 'stale', details: {} } } })
  fireEvent.click(screen.getByRole('button', { name: desktopEn.confirm }))
  await screen.findByRole('alert')
  expect(screen.queryByRole('button', { name: desktopEn.confirm })).toBeNull()
})

it.each([true, false])('discards a pending save after closing the dialog (resolves=%s)', async (resolves) => {
  const f = fixture(), reply = Promise.withResolvers<ReturnType<typeof ok<DesktopConfirmation>>>()
  f.confirm.mockReturnValueOnce(reply.promise)
  render(<DesktopConfirmationAction {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: /Desktop access/ }))
  await screen.findByText('display-0')
  fireEvent.click(screen.getByRole('button', { name: desktopEn.confirm }))
  await screen.findByRole('button', { name: desktopEn.saving })
  fireEvent.click(screen.getByRole('button', { name: desktopEn.close }))
  await act(async () => { if (resolves) reply.resolve(ok({ ...f.value, confirmed: true })); else reply.reject(new Error('cancelled')); await reply.promise.catch(() => undefined) })
  expect(f.confirm.mock.calls[0]![1]!.aborted).toBe(true)
  expect(screen.queryByText(desktopEn.granted)).toBeNull()
})
