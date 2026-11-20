/** Local recovery navigation keeps exact operation forms while independently paging metadata. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PendingEditsProvider } from '../pending-edits.tsx'
import { LocalRecoveryExecutionSection } from './LocalRecoveryExecutionSection.tsx'

beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => 'en' }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('keeps an ordinary single-computer page unchanged when there are no recovered projects', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ items: [] }))
  vi.stubGlobal('fetch', fetcher)
  const view = render(<LocalRecoveryExecutionSection />)
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  expect(view.container.textContent).toBe('')
  expect(fetcher.mock.calls[0]?.[0]).toBe('/admin/api/peer-backups/recoveries/local-execution')
  const signal = (fetcher.mock.calls[0]?.[1] as RequestInit).signal!
  view.unmount()
  expect(signal.aborted).toBe(true)
})

it('retains a partially reviewed local project while paging and blocks switching until the form is closed', async () => {
  const calls: string[] = []
  const row = (id: string, projectId: number) => ({ id, scopeKind: 'project', projectId, runtimeId: 'runtime-' + id, pointId: 'point-' + id })
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    calls.push(input)
    if (input.endsWith('local-execution')) return Response.json({ items: [row('one', 1)], nextCursor: 'one' })
    if (input.endsWith('local-execution?after=one')) return Response.json({ items: [row('two', 2)] })
    return Response.json({ recoveryMode: 'disaster', phase: 'published', runtimeId: 'runtime', pointId: 'point',
      targetNodeId: 'local', targetEpoch: '2', reviewRevision: 'revision', status: 'review-required',
      preparationStatus: 'ready', oldSessionCount: 1, tasksSuspended: true, sessionsReadOnly: true,
      errorCode: null, items: [], blockers: [] })
  }))
  render(<PendingEditsProvider><LocalRecoveryExecutionSection /></PendingEditsProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Review new-conversation permission' }))
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'More recovered spaces' }))
  const picker = await screen.findByRole('combobox', { name: 'Recovered space' })
  fireEvent.change(picker, { target: { value: 'project/two' } })
  await screen.findByRole('dialog', { name: 'Keep your current edits' })
  expect((picker as HTMLSelectElement).value).toBe('project/one')
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  expect(calls.some(path => path.endsWith('/two/execution'))).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Stay on this page' }))
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  fireEvent.change(picker, { target: { value: 'project/two' } })
  await waitFor(() => expect(calls).toContain('/admin/api/peer-backups/recoveries/two/execution'))
  expect(screen.queryByRole('button', { name: 'Add policy' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Prepare replacement' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: 'Source computer' })).toBeNull()
})


it('keeps personal and project recovery identities distinct and opens local personal review without a remote selector', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    calls.push(input)
    if (input.endsWith('local-execution')) return Response.json({ items: [
      { id: 'same', scopeKind: 'project', projectId: 1, runtimeId: 'project-runtime', pointId: 'p1' },
      { id: 'same', scopeKind: 'personal', userId: 2, runtimeId: 'personal-runtime', pointId: 'p2' },
    ] })
    return Response.json({ recoveryMode: 'disaster', phase: 'published', runtimeId: 'runtime', pointId: 'point',
      targetNodeId: 'local', targetEpoch: '2', reviewRevision: null, status: 'unprepared',
      preparationStatus: 'idle', oldSessionCount: null, tasksSuspended: true, sessionsReadOnly: true,
      errorCode: null, items: [], blockers: [] })
  }))
  render(<LocalRecoveryExecutionSection />)
  const picker = await screen.findByRole('combobox', { name: 'Recovered space' })
  fireEvent.change(picker, { target: { value: 'personal/same' } })
  await waitFor(() => expect(calls).toContain('/admin/api/peer-backups/personal-recoveries/same/execution'))
  expect((picker as HTMLSelectElement).value).toBe('personal/same')
  expect(screen.getAllByText('User 2 · Runtime personal').length).toBeGreaterThan(0)
  expect(screen.queryByRole('combobox', { name: 'Source computer' })).toBeNull()
})
