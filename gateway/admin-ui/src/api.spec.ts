import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deleteUser,
  getProjectModelAccess,
  getProjectUsage,
  getUsageHealth,
  listUsageContributors,
  listUsageOverview,
  listAudit,
  listModelRegistrations,
  listModelProviders,
  listUsers,
  patchUser,
  saveModelProvider,
  setMember,
  setAllProjectModelAccess,
  setProjectModelAccess,
  setQuota,
} from './api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonOk(body: unknown = {}, status = 200) {
  return {
    ok: true,
    status,
    json: async () => body,
  }
}

describe('admin api URLs', () => {
  it('GETs /admin/api/users with same-origin credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk([]))
    vi.stubGlobal('fetch', fetchMock)
    await listUsers()
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/users', {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    })
  })

  it('PATCHes /admin/api/users/:id without a handwritten Origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk(undefined, 204))
    vi.stubGlobal('fetch', fetchMock)
    await patchUser(7, { status: 'disabled' })
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/users/7', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    })
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('headers', expect.objectContaining({ origin: expect.anything() }))
  })

  it('DELETEs /admin/api/users/:id with same-origin credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk(undefined, 204))
    vi.stubGlobal('fetch', fetchMock)
    await deleteUser(7)
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/users/7', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    })
  })

  it('PUTs member mode and GETs audit with actionPrefix', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonOk(undefined, 204))
      .mockResolvedValueOnce(jsonOk([]))
    vi.stubGlobal('fetch', fetchMock)
    await setMember(3, 9, 'rw')
    await listAudit({ userId: 9, actionPrefix: 'admin.', limit: 50, offset: 0 })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/admin/api/projects/3/members/9')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/admin/api/audit?userId=9&actionPrefix=admin.&limit=50&offset=0')
  })

  it('GETs project usage and PUTs an explicit project quota source', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonOk({ month: '2026-08' }))
      .mockResolvedValueOnce(jsonOk(undefined, 204))
    vi.stubGlobal('fetch', fetchMock)
    await getProjectUsage(3, '2026-08')
    await setQuota({
      subjectType: 'project',
      subjectId: '3',
      tokenLimit: 'inherit',
      companyCostMicrosLimit: 'inherit',
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/admin/api/usage?projectId=3&month=2026-08')
    expect(fetchMock.mock.calls[1]).toEqual([
      '/admin/api/quotas',
      {
        method: 'PUT',
        body: JSON.stringify({
          subjectType: 'project',
          subjectId: '3',
          tokenLimit: 'inherit',
          companyCostMicrosLimit: 'inherit',
        }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      },
    ])
  })

  it('GETs the usage overview and contributor report with the selected month', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonOk({ month: '2026-08', users: [] }))
      .mockResolvedValueOnce(jsonOk({ month: '2026-08', rows: [] }))
      .mockResolvedValueOnce(jsonOk({ month: '2026-08' }))
    vi.stubGlobal('fetch', fetchMock)
    await listUsageOverview('2026-08')
    await listUsageContributors(7, '2026-08')
    await getUsageHealth('2026-08')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/admin/api/usage/overview?month=2026-08')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/admin/api/usage/contributors?projectId=7&month=2026-08')
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/admin/api/usage/health?month=2026-08')
  })

  it('GETs filtered personal model registration history', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk({ summary: {}, rows: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await listModelRegistrations({ userId: 7, provider: 'custom', model: 'chat', action: 'model-created', limit: 25 })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/admin/api/model-registrations?userId=7&provider=custom&model=chat&action=model-created&limit=25')
  })

  it('reads and writes organization providers and project model assignments', async () => {
    const provider = {
      provider: 'org-primary',
      displayName: 'Primary',
      driver: 'pi-ai' as const,
      protocol: 'openai-completions' as const,
      baseURL: 'https://api.example.com/v1',
      authMode: 'api-key' as const,
      status: 'draft' as const,
      credential: 'secret',
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonOk([]))
      .mockResolvedValueOnce(jsonOk(undefined, 204))
      .mockResolvedValueOnce(jsonOk({ effective: {}, overrides: [] }))
      .mockResolvedValueOnce(jsonOk(undefined, 204))
      .mockResolvedValueOnce(jsonOk(undefined, 204))
      .mockResolvedValueOnce(jsonOk(undefined, 204))
    vi.stubGlobal('fetch', fetchMock)
    await listModelProviders()
    await saveModelProvider(provider)
    await getProjectModelAccess(11)
    await setProjectModelAccess(11, 'org-primary', 'deepseek-chat', true)
    await setAllProjectModelAccess(11, true)
    await setAllProjectModelAccess(11, null)
    expect(fetchMock.mock.calls).toEqual([
      ['/admin/api/model-providers', {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      }],
      ['/admin/api/model-providers', {
        method: 'PUT',
        body: JSON.stringify(provider),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      }],
      ['/admin/api/project-model-access?projectId=11', {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      }],
      ['/admin/api/project-model-access', {
        method: 'PUT',
        body: JSON.stringify({ projectId: 11, provider: 'org-primary', model: 'deepseek-chat', allowed: true }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      }],
      ['/admin/api/project-model-access', {
        method: 'PUT',
        body: JSON.stringify({ projectId: 11, all: true, allowed: true }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      }],
      ['/admin/api/project-model-access', {
        method: 'PUT',
        body: JSON.stringify({ projectId: 11, all: true, allowed: null }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      }],
    ])
  })

  it('throws Error from JSON error on !res.ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'cannot-remove-last-admin' }),
    }))
    await expect(patchUser(1, { status: 'disabled' })).rejects.toThrow('cannot-remove-last-admin')
  })

  it('rejects an oversized streamed response before parsing it', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(16 * 1024 * 1024 + 1)))
      },
      cancel() { cancelled = true },
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
    await expect(listUsers()).rejects.toThrow('Admin response is too large.')
    expect(cancelled).toBe(true)
  })
})
