import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { UsagePage } from './UsagePage.tsx'

vi.mock('../api.ts', () => ({
  getUsageHealth: vi.fn(),
  listUsageOverview: vi.fn(),
  listUsers: vi.fn(),
  setQuota: vi.fn(),
}))

const pricing = { status: 'priced' as const, pricedCalls: 2, unpricedCalls: 0, configuredZeroCalls: 0, unknownCalls: 0 }
const emptyPricing = { status: 'none' as const, pricedCalls: 0, unpricedCalls: 0, configuredZeroCalls: 0, unknownCalls: 0 }
const personal = (calls: number, totalTokens: number) => ({
  month: '2026-08', inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  totalTokens, estimatedCostMicros: 0, companyCostMicros: 0, calls, missingUsageCalls: 0,
  tokenLimit: null, companyCostMicrosLimit: null, alerts: [], pricing: calls === 0 ? emptyPricing : pricing,
})
const measure = (calls: number, totalTokens: number) => ({
  inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens,
  estimatedCostMicros: 0, companyCostMicros: 0, calls, missingUsageCalls: 0,
  pricing: calls === 0 ? emptyPricing : pricing,
})

describe('UsagePage', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getUsageHealth).mockResolvedValue({
      month: '2026-08', timeZone: 'Asia/Shanghai', missingUsageCalls: 0,
      unattributedProjectCalls: 1, unattributedProjectTokens: 200, unpricedCalls: 0,
      historicalUnknownCalls: 0, maxIntakeLagMs: 120,
    })
    vi.mocked(api.listUsers).mockResolvedValue([])
    vi.mocked(api.setQuota).mockResolvedValue(undefined)
    vi.mocked(api.listUsageOverview).mockResolvedValue({
      month: '2026-08', timeZone: 'Asia/Shanghai',
      personal: measure(2, 100), projects: measure(4, 900), unattributedProjects: measure(1, 200),
      users: [
        { userId: 1, username: 'alice', archived: false, personal: personal(2, 100), projectContribution: measure(3, 700) },
        { userId: 2, username: 'bob', archived: false, personal: personal(0, 0), projectContribution: measure(0, 0) },
      ],
    })
  })

  it('separates personal billing from shared-project contribution activity', async () => {
    render(<UsagePage />)
    expect(await screen.findByText('项目 Token')).toBeTruthy()
    expect(screen.getByText('900')).toBeTruthy()
    const table = screen.getByRole('table')
    expect(within(table).getByText('alice')).toBeTruthy()
    expect(within(table).getByText('700')).toBeTruthy()
    expect(within(table).getAllByText(/不计入个人额度/)).toHaveLength(2)
    expect(within(table).getByText('bob')).toBeTruthy()
  })
})
