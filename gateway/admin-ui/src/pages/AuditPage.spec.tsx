/** Audit request results remain separate from the target operation's recorded state. */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { listAudit } from '../api.ts'
import { AuditPage } from './AuditPage.tsx'

vi.mock('../api.ts', () => ({ listAudit: vi.fn() }))
afterEach(cleanup)

it('shows target, revision and unknown execution beside a successful request', async () => {
  vi.mocked(listAudit).mockResolvedValue([{ id: 1, ts: 1, userId: 2, action: 'admin.webhook-deliveries.redispatch',
    status: 200, methodPath: '', ip: '127.0.0.1', outcome: 'success',
    metadata: { targetId: 7, revision: '12', state: 'unknown' } }])
  render(<AuditPage />)
  const table = within(await screen.findByRole('table'))
  expect(table.getByText('请求成功 · HTTP 200')).toBeTruthy()
  expect(table.getByText('目标 ID')).toBeTruthy()
  expect(table.getByText('7')).toBeTruthy()
  expect(table.getByText('配置代次')).toBeTruthy()
  expect(table.getByText('12')).toBeTruthy()
  expect(table.getByText('unknown')).toBeTruthy()
})
