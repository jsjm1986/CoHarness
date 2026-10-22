/** Complete-event UTF-8 accounting and reservation rollback for provider-wide retention. */

import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { JsonlRetentionBudget } from '../src/retention.ts'

const event: SessionEvent = { type: 'request/context', seq: SessionSeq(0), time: 0, data: { provider: '测试', model: '模型' } }
const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8')

it.each(['maxPendingEvents', 'maxPendingBytes'] as const)('requires a positive safe-integer %s', (field) => {
  for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => new JsonlRetentionBudget({ [field]: value })).toThrow(/positive safe integer/u)
  }
})

it('includes the complete envelope and multibyte payload at the exact byte capacity', () => {
  const budget = new JsonlRetentionBudget({ maxPendingBytes: eventBytes })
  const release = budget.reserve(event)
  expect(() => budget.reserve(event)).toThrow(/pending-byte limit/u)
  release()
  release()
  const second = budget.reserve(event)
  second()
  expect(() => new JsonlRetentionBudget({ maxPendingBytes: eventBytes - 1 }).reserve(event)).toThrow(/pending-byte limit/u)
})

it('keeps a refused event out of the shared event account', () => {
  const budget = new JsonlRetentionBudget({ maxPendingEvents: 1 })
  const release = budget.reserve(event)
  expect(() => budget.reserve(event)).toThrow(/pending-event limit/u)
  release()
  expect(() => budget.reserve(event)).not.toThrow()
})
