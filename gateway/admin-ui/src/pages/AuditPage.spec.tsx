/** Audit request results remain separate from the target operation's recorded state. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { listAudit, type AuditEntry } from '../api.ts'
import { AuditPage } from './AuditPage.tsx'

vi.mock('../api.ts', () => ({ listAudit: vi.fn() }))
beforeEach(() => { vi.clearAllMocks() })
afterEach(cleanup)

it('shows a failed initial query without claiming no matching records or a loaded page', async () => {
  vi.mocked(listAudit).mockRejectedValue(new Error('Audit unavailable'))
  render(<AuditPage />)
  expect((await screen.findByRole('alert')).textContent).toContain('Audit unavailable')
  expect(screen.queryByText('没有匹配的记录')).toBeNull()
  expect(screen.queryByText('第 1 页')).toBeNull()
  expect(listAudit).toHaveBeenCalledOnce()
})

it('shows the empty state for a successful query with no matching records', async () => {
  vi.mocked(listAudit).mockResolvedValue({ entries: [], total: 0 })
  render(<AuditPage />)
  expect(await screen.findByText('没有匹配的记录')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(listAudit).toHaveBeenCalledOnce()
})

it('shows target, revision and unknown execution beside a successful request', async () => {
  vi.mocked(listAudit).mockResolvedValue({ entries: [{ id: 1, ts: 1, userId: 2, username: 'admin', displayName: 'Admin',
    action: 'admin.webhook-deliveries.redispatch', status: 200, methodPath: '', ip: '127.0.0.1', outcome: 'success',
    metadata: { targetId: 7, revision: '12', state: 'unknown' } }], total: 1 })
  render(<AuditPage />)
  const table = within(await screen.findByRole('table'))
  expect(table.getByText('请求成功 · HTTP 200')).toBeTruthy()
  expect(table.getByText('目标 ID')).toBeTruthy()
  expect(table.getByText('7')).toBeTruthy()
  expect(table.getByText('配置代次')).toBeTruthy()
  expect(table.getByText('12')).toBeTruthy()
  expect(table.getByText('unknown')).toBeTruthy()
  expect(table.getByText('@admin')).toBeTruthy()
})

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function page(username: string): Awaited<ReturnType<typeof listAudit>> {
  const row: AuditEntry = { id: 1, ts: 1, userId: 2, username, displayName: username,
    action: 'login', status: 200, methodPath: '', ip: '127.0.0.1', outcome: 'success', metadata: {} }
  return { entries: [row], total: 1 }
}

it.each(['success', 'failure'] as const)('retains the latest selected audit family after an older query finishes with %s', async outcome => {
  const old = deferred<Awaited<ReturnType<typeof listAudit>>>()
  vi.mocked(listAudit).mockReturnValueOnce(old.promise).mockResolvedValueOnce(page('latest-auditor'))
  render(<AuditPage />)
  const tab = screen.getByRole('button', { name: '认证' })
  fireEvent.click(tab)
  expect(await screen.findAllByText('@latest-auditor')).toHaveLength(2)
  await act(async () => {
    if (outcome === 'success') old.resolve(page('outdated-auditor'))
    else old.reject(new Error('Outdated audit failure'))
  })
  expect(screen.getAllByText('@latest-auditor')).toHaveLength(2)
  expect(screen.queryAllByText('@outdated-auditor')).toHaveLength(0)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(tab.getAttribute('aria-pressed')).toBe('true')
  expect(listAudit).toHaveBeenNthCalledWith(2, expect.objectContaining({ family: 'auth' }))
})

it('keeps the latest audit query loading when an older query settles first', async () => {
  const old = deferred<Awaited<ReturnType<typeof listAudit>>>(), latest = deferred<Awaited<ReturnType<typeof listAudit>>>()
  vi.mocked(listAudit).mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
  render(<AuditPage />)
  fireEvent.click(screen.getByRole('button', { name: '认证' }))
  await act(async () => { old.resolve(page('outdated-auditor')) })
  expect(screen.getByText('正在加载审计日志')).toBeTruthy()
  expect(screen.queryAllByText('@outdated-auditor')).toHaveLength(0)
  await act(async () => { latest.resolve(page('latest-auditor')) })
  expect(screen.getAllByText('@latest-auditor')).toHaveLength(2)
})
