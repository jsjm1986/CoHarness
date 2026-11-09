/** Current administrator qualification is checked immediately before read data and headers are published. */
import { expect, it, vi } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import { AdministratorReadUnavailableError, createAdministratorResponse } from '../src/admin-response.ts'

const administrator: UserRow = {
  id: 7, username: 'admin', displayName: 'Administrator', role: 'admin', status: 'active',
  homePath: '/fixture/admin', mustChangePassword: false, autoReviewEligible: false,
}

it.each(['GET', 'HEAD', 'POST-read'])('publishes %s data and headers only after current authority is established', async method => {
  const getById = vi.fn(async () => administrator), write = vi.fn()
  const response = createAdministratorResponse({ getById }, administrator.id, method === 'POST-read' ? 'POST' : method, write)
  await response[method === 'POST-read' ? 'readJson' : 'json'](200, { users: ['another-account'] }, { 'x-total-count': '1' })
  expect(getById).toHaveBeenCalledExactlyOnceWith(administrator.id)
  expect(write).toHaveBeenCalledExactlyOnceWith(200, { users: ['another-account'] }, { 'x-total-count': '1' })
})

it.each(['GET', 'POST'])('refuses read publication on %s after current administrator eligibility is lost', async method => {
  const write = vi.fn()
  const response = createAdministratorResponse({ getById: async () => ({ ...administrator, role: 'user' }) }, administrator.id, method, write)
  await expect(response.readJson(200, { private: 'selected data' }, { 'x-total-count': '1' })).rejects.toMatchObject({ code: 'forbidden' })
  expect(write).not.toHaveBeenCalled()
})

it.each([
  null,
  { ...administrator, role: 'user' as const },
  { ...administrator, status: 'disabled' as const },
  { ...administrator, mustChangePassword: true },
])('refuses read publication after current administrator eligibility is lost: %j', async current => {
  const write = vi.fn()
  const response = createAdministratorResponse({ getById: async () => current }, administrator.id, 'GET', write)
  await expect(response.json(200, { private: 'selected data' }, { 'x-total-count': '1' }))
    .rejects.toMatchObject({ code: 'forbidden' })
  expect(write).not.toHaveBeenCalled()
})

it('leaves the response unpublished while current authority is pending', async () => {
  let complete!: (user: UserRow | null) => void
  const decision = new Promise<UserRow | null>(resolve => { complete = resolve }), write = vi.fn()
  const response = createAdministratorResponse({ getById: () => decision }, administrator.id, 'GET', write)
  const selected = response.json(200, { private: true })
  const outcome = selected.then(() => undefined, (error: unknown) => error)
  try { expect(write).not.toHaveBeenCalled() }
  finally { complete({ ...administrator, role: 'user' }) }
  expect(await outcome).toMatchObject({ code: 'forbidden' })
  expect(write).not.toHaveBeenCalled()
})

it('refuses unavailable authority without publishing data or internal lookup details', async () => {
  const cause = new Error('synthetic internal database detail'), write = vi.fn()
  const response = createAdministratorResponse({ getById: async () => { throw cause } }, administrator.id, 'GET', write)
  const error = await response.json(200, { private: true }).catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(AdministratorReadUnavailableError)
  expect(error).toMatchObject({ cause, message: expect.not.stringContaining(cause.message) })
  expect(write).not.toHaveBeenCalled()
})

it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('preserves an admitted %s mutation response without another authorization decision', async method => {
  const getById = vi.fn(async () => { throw new Error('mutation authority belongs to the committing service') }), write = vi.fn()
  const response = createAdministratorResponse({ getById }, administrator.id, method, write)
  await response.json(201, { committed: true })
  expect(getById).not.toHaveBeenCalled()
  expect(write).toHaveBeenCalledExactlyOnceWith(201, { committed: true }, undefined)
})

it('retains endpoint error fields after current read authority is confirmed', async () => {
  const write = vi.fn()
  const response = createAdministratorResponse({ getById: async () => administrator }, administrator.id, 'GET', write)
  await response.error(404, 'not found')
  await response.error(503, 'unavailable', 'feature-unavailable')
  expect(write.mock.calls).toEqual([[404, { error: 'not found' }, undefined], [503, { error: 'unavailable', code: 'feature-unavailable' }, undefined]])
})
