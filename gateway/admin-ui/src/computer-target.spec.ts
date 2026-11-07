import { parseConversationArchiveId } from '../../src/archive-identity.ts'
/** Existing Admin operations retain their document's computer without changing center enrollment. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { adminComputerBase, adminComputerRequestUrl, adminComputerTarget } from './computer-target.ts'
import { controlInstance, exportArchive, getAdminComputerContext, getProjectModelAccess, getProjectUsage, getUserComputerProfile, listAudit, listModelProviders, listNodeAccess, listUsageContributors, listUsageOverview, listUsers, patchUser, resetPassword, setAllProjectModelAccess, setProjectModelAccess, setQuota } from './api.ts'

const node = '61f22202-1c02-4a3c-8d34-f11222333444'
const base = `/admin/computers/${node}`
beforeEach(() => { window.history.replaceState({}, '', `${base}/users/7`) })
afterEach(() => { vi.restoreAllMocks(); window.history.replaceState({}, '', '/admin/') })

it('selects one canonical computer while ordinary Admin paths stay at the center', () => {
  expect(adminComputerTarget(`${base}/projects/2`)).toBe(node)
  expect(adminComputerBase(adminComputerTarget(`${base}/`))).toBe(base)
  expect(adminComputerTarget('/admin/deployment')).toBeUndefined()
  expect(adminComputerBase()).toBe('/admin')
  for (const path of ['/admin/computers', '/admin/computers/', '/admin/computers/invalid/']) {
    expect(() => adminComputerTarget(path)).toThrow('Invalid Admin computer address')
  }
})

it('retains API arguments and download targets without changing external or account URLs', () => {
  expect(adminComputerRequestUrl('/admin/api/documents?cursor=next#row')).toBe(`/admin/api/documents?cursor=next&dshNode=${node}#row`)
  expect(adminComputerRequestUrl('/admin/api/users?dshNode=wrong')).toBe('/admin/api/users?dshNode=wrong')
  expect(exportArchive(parseConversationArchiveId('22000000-0000-4000-8000-000000000022')!)).toBe(`/admin/api/archives/records/22000000-0000-4000-8000-000000000022/export?dshNode=${node}`)
  expect(adminComputerRequestUrl('https://external.example/admin/api/users')).toBe('https://external.example/admin/api/users')
  expect(adminComputerRequestUrl('/account/api/profile')).toBe('/account/api/profile')
  expect(adminComputerRequestUrl('/admin/api/users', '/admin/users')).toBe('/admin/api/users')
})

it('keeps node enrollment, center identity and the organization runtime directory at the center', () => {
  for (const url of ['/admin/api/deployment/current-node', '/admin/api/deployment/nodes/access?cursor=next',
    '/admin/api/deployment/nodes/enrollments', '/admin/api/runtimes']) {
    expect(adminComputerRequestUrl(url)).toBe(url)
  }
})

it('keeps account administration at the center while instance and audit reads follow this computer', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('[]', { headers: { 'content-type': 'application/json' } }))
  await listUsers()
  await patchUser(7, { status: 'disabled' })
  await resetPassword(7, 'replacement-password')
  await listUsers('computer')
  await getUserComputerProfile(7)
  await controlInstance(7, 'start')
  await listAudit({ actionPrefix: 'admin.', limit: 20 })
  expect(fetch.mock.calls.map(call => call[0])).toEqual([
    '/admin/api/users',
    '/admin/api/users/7',
    '/admin/api/users/7/password',
    `/admin/api/users?dshNode=${node}`,
    `/admin/api/users/7?dshNode=${node}`,
    `/admin/api/users/7/instance/start?dshNode=${node}`,
    `/admin/api/audit?actionPrefix=admin.&limit=20&dshNode=${node}`,
  ])
  expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'PATCH', body: '{"status":"disabled"}', credentials: 'same-origin' })
})

it('keeps shared model, usage and quota operations available independently of the selected computer', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))
  await listModelProviders()
  await listUsageOverview('2026-10')
  await setQuota({ subjectType: 'user', subjectId: '7', tokenLimit: 'inherit', companyCostMicrosLimit: 'inherit' })
  expect(fetch.mock.calls.map(call => call[0])).toEqual([
    '/admin/api/model-providers', '/admin/api/usage/overview?month=2026-10', '/admin/api/quotas',
  ])
  for (const path of ['models', 'model-providers', 'model-settings', 'model-registrations', 'model-access', 'project-model-access', 'quotas', 'usage']) {
    expect(adminComputerRequestUrl(`/admin/api/${path}?filter=kept`)).toBe(`/admin/api/${path}?filter=kept`)
  }
  expect(adminComputerRequestUrl('/admin/api/projects/3')).toBe(`/admin/api/projects/3?dshNode=${node}`)
})

it('loads center metadata independently of the selected computer', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ nodeId: node, name: 'Center', forwardingEnabled: true }))
    .mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }))
  expect((await getAdminComputerContext()).nodeId).toBe(node)
  await listNodeAccess()
  expect(fetch.mock.calls.map(call => call[0])).toEqual(['/admin/api/deployment/current-node', '/admin/api/deployment/nodes/access'])
})

it('keeps project model access, quota and usage on the project computer while shared reports stay at the center', async () => {
  window.history.replaceState({}, '', `${base}/projects/3`)
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))
  await getProjectModelAccess(3)
  await setProjectModelAccess(3, 'managed', 'model', true)
  await setAllProjectModelAccess(3, null)
  await setQuota({ subjectType: 'project', subjectId: '3', tokenLimit: 'inherit', companyCostMicrosLimit: 'inherit' })
  await getProjectUsage(3, '2026-10')
  await listUsageContributors(3, '2026-10')
  await listUsageContributors(undefined, '2026-10')
  expect(fetch.mock.calls.map(call => call[0])).toEqual([
    `/admin/api/project-model-access?projectId=3&dshNode=${node}`,
    `/admin/api/project-model-access?dshNode=${node}`,
    `/admin/api/project-model-access?dshNode=${node}`,
    `/admin/api/quotas?dshNode=${node}`,
    `/admin/api/usage?projectId=3&month=2026-10&dshNode=${node}`,
    `/admin/api/usage/contributors?projectId=3&month=2026-10&dshNode=${node}`,
    '/admin/api/usage/contributors?month=2026-10',
  ])
  expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ projectId: 3, provider: 'managed', model: 'model', allowed: true }) })
  expect(fetch.mock.calls[3]![1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ subjectType: 'project', subjectId: '3', tokenLimit: 'inherit', companyCostMicrosLimit: 'inherit' }) })
})

it('keeps local project requests local without introducing a computer selector', async () => {
  window.history.replaceState({}, '', '/admin/projects/3')
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))
  await getProjectModelAccess(3)
  await getProjectUsage(3, '2026-10')
  await setQuota({ subjectType: 'project', subjectId: '3', tokenLimit: null, companyCostMicrosLimit: null })
  expect(fetch.mock.calls.map(call => call[0])).toEqual([
    '/admin/api/project-model-access?projectId=3',
    '/admin/api/usage?projectId=3&month=2026-10',
    '/admin/api/quotas',
  ])
})

it('reports a disconnected computer in plain language and does not replay the operation', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'node-service/unavailable' }, { status: 503 }))
  await expect(getUserComputerProfile(7)).rejects.toMatchObject({ status: 503, message: '无法连接所选电脑，请检查连接后重试' })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('refuses an invalid document target before sending any management request', async () => {
  window.history.replaceState({}, '', '/admin/computers/invalid/')
  const fetch = vi.spyOn(globalThis, 'fetch')
  await expect(getUserComputerProfile(7)).rejects.toThrow('Invalid Admin computer address')
  expect(fetch).not.toHaveBeenCalled()
})
