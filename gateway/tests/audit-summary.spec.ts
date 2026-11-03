import { expect, it } from 'vitest'
import { auditSummary } from '../src/audit-summary.ts'

it('exposes target, revision and outcomes without returning arbitrary durable detail', () => {
  expect(auditSummary({ status: 200, detail: JSON.stringify({
    target: { kind: 'project', id: 8, password: 'do-not-expose' }, revision: '12',
    generation: 3, state: 'unknown', requested: 4, succeeded: 2, shared: true,
    runtimeId: '76c5b3ae-f5ca-4134-ae05-93b1ed362f32', requestId: '6c3867c3-b44c-4c8a-b28d-f35f84bb8254',
    secret: 'do-not-expose', token: 'do-not-expose', path: '/private/key', body: { prompt: 'private' },
    name: 'untrusted free text', detail: { revision: '99', secret: 'do-not-expose' },
  }) })).toEqual({ outcome: 'success', metadata: {
    targetKind: 'project', targetId: 8, revision: '12', generation: 3, state: 'unknown',
    requested: 4, succeeded: 2, shared: true,
    runtimeId: '76c5b3ae-f5ca-4134-ae05-93b1ed362f32', requestId: '6c3867c3-b44c-4c8a-b28d-f35f84bb8254',
  } })
})

it.each(['private raw string', 'null', '[{"targetId":1}]', '{"revision":{},"targetId":[],"state":"secret text"}'])
('withholds malformed or non-allowlisted detail (%s)', detail => {
  expect(auditSummary({ status: null, detail })).toEqual({ outcome: 'recorded', metadata: {} })
})

it('preserves explicit failure and unknown results independently from an HTTP success', () => {
  expect(auditSummary({ status: 200, outcome: 'failure', detail: '{}' }).outcome).toBe('failure')
  expect(auditSummary({ status: null, outcome: 'unknown', detail: '{}' }).outcome).toBe('unknown')
  expect(auditSummary({ status: 403, outcome: 'success', detail: '{}' }).outcome).toBe('failure')
})
