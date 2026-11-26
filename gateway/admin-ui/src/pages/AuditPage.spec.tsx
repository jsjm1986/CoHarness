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

function rows(count: number, username = 'auditor'): AuditEntry[] {
  return Array.from({ length: count }, (_, index): AuditEntry => ({
    id: index + 1, ts: 1, userId: 2, username, displayName: username,
    action: 'login', status: 200, methodPath: '', ip: '127.0.0.1', outcome: 'success', metadata: {},
  }))
}

it('pages forward and back through audit offsets and disables exhausted directions', async () => {
  vi.mocked(listAudit).mockImplementation(async () => ({ entries: rows(50), total: 120 }))
  render(<AuditPage />)
  const directions = () => ({
    prev: screen.getByRole('button', { name: '上一页' }) as HTMLButtonElement,
    next: screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement,
  })
  await screen.findByText('第 1 页 / 3')
  expect(directions().prev.disabled).toBe(true)
  expect(directions().next.disabled).toBe(false)

  fireEvent.click(directions().next)
  await screen.findByText('第 2 页 / 3')
  expect(listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50, limit: 50 }))
  expect(directions().prev.disabled).toBe(false)
  expect(directions().next.disabled).toBe(false)

  fireEvent.click(directions().next)
  await screen.findByText('第 3 页 / 3')
  expect(listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 100 }))
  expect(directions().next.disabled).toBe(true)

  fireEvent.click(directions().prev)
  await screen.findByText('第 2 页 / 3')
  expect(listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 }))
})

it('sends the datetime range as milliseconds and surfaces a refused range', async () => {
  vi.mocked(listAudit)
    .mockResolvedValueOnce({ entries: rows(1), total: 1 })
    .mockRejectedValueOnce(new Error('invalid audit time range'))
  render(<AuditPage />)
  await screen.findAllByText('@auditor')
  fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '2026-11-20T10:00' } })
  fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '2026-11-01T10:00' } })
  fireEvent.submit(screen.getByRole('button', { name: '应用筛选' }).closest('form')!)
  await screen.findByRole('alert')
  expect(listAudit).toHaveBeenLastCalledWith(expect.objectContaining({
    from: new Date('2026-11-20T10:00').getTime(),
    to: new Date('2026-11-01T10:00').getTime(),
    offset: 0,
  }))
})
