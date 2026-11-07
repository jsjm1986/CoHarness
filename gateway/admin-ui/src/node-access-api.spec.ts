/** Real REST parsing checks node-operation receipts before the UI can report success. */
import { afterEach, expect, it, vi } from 'vitest'
import { nodeAccessEntrySchema, nodeEnrollmentSchema } from '../../src/node-access.ts'
import { issueNodeEnrollment, listNodeAccess, NodeAccessResponseError, reissueNodeEnrollment, revokeNodeAccess } from './api.ts'

const node = nodeAccessEntrySchema.parse({ nodeId: '61f22202-1c02-4a3c-8d34-f11222333444', name: 'Computer A', revision: 2,
  status: 'connected', platform: 'linux', architecture: 'x64', lastSeenAt: null, leaseExpiresAt: null, executionReady: false })
const receipt = nodeEnrollmentSchema.parse({ nodeId: node.nodeId, enrollmentId: '10111111-1111-4111-8111-111111111111', revision: 1,
  token: `dsh_enroll_${'A'.repeat(43)}`, expiresAt: '2026-10-28T11:00:00.000Z' })
afterEach(() => { vi.restoreAllMocks() })

function respond(value: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }))
}

it('requests a single uncached page with the view-owned abort signal', async () => {
  const fetch = respond({ items: [node], nextCursor: node.nodeId })
  const controller = new AbortController()
  expect((await listNodeAccess(node.nodeId, controller.signal)).items).toEqual([node])
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`/admin/api/deployment/nodes/access?cursor=${node.nodeId}`,
    expect.objectContaining({ cache: 'no-store', credentials: 'same-origin', signal: controller.signal }))
})

it.each([
  { items: [{ ...node, executionReady: 'yes' }], nextCursor: null },
  { items: [{ ...node, nodeId: 'wrong-id' }], nextCursor: null },
  { items: Array.from({ length: 201 }, () => node), nextCursor: null },
])('refuses incompatible or unbounded directory responses', async value => {
  respond(value)
  await expect(listNodeAccess()).rejects.toThrow()
})

it('accepts one issuance response bound to its request and never retries it', async () => {
  const fetch = respond(receipt, 201)
  expect(await issueNodeEnrollment('Computer A', receipt.enrollmentId)).toEqual(receipt)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ name: 'Computer A', requestId: receipt.enrollmentId })
})

it('refuses an issuance receipt for a different request', async () => {
  respond({ ...receipt, enrollmentId: '20222222-2222-4222-8222-222222222222' })
  await expect(issueNodeEnrollment('Computer A', receipt.enrollmentId)).rejects.toBeInstanceOf(NodeAccessResponseError)
})

it('sends the reviewed revision for reissuance and rejects a mismatched receipt', async () => {
  const fetch = respond({ ...receipt, revision: 4 })
  await expect(reissueNodeEnrollment(node, receipt.enrollmentId)).rejects.toBeInstanceOf(NodeAccessResponseError)
  expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ action: 'issue-enrollment', revision: 2, requestId: receipt.enrollmentId })
})

it('refuses a revocation response for another node', async () => {
  respond({ nodeId: '20222222-2222-4222-8222-222222222222', revision: 3, status: 'revoked' })
  await expect(revokeNodeAccess(node)).rejects.toBeInstanceOf(NodeAccessResponseError)
})

it('retains a typed refusal status without retrying a mutation', async () => {
  const fetch = respond({ error: 'node-access/revision-conflict' }, 409)
  await expect(revokeNodeAccess(node)).rejects.toMatchObject({ status: 409, message: 'node-access/revision-conflict' })
  expect(fetch).toHaveBeenCalledTimes(1)
})
