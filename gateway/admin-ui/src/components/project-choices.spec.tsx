import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Project } from '../api.ts'
import { useProjectChoices } from './project-choices.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('loads only the focused setting’s visible projects and forgets known labels after authorization is withdrawn', async () => {
  const node = '20000000-0000-4000-8000-000000000001' as NonNullable<Project['nodeId']>
  const rows = Array.from({ length: 40 }, (_, index): Project => ({ id: index + 1, name: `#${index + 1}`, path: '', memberCount: 0,
    metadataOnNode: true, nodeId: node, runtimeId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` as NonNullable<Project['runtimeId']> }))
  const fetch = vi.fn(async (url: string) => {
    const query = new URL(url, 'https://qa.invalid').searchParams
    const ids = (query.get('ids') ?? '').split(',').map(Number)
    return Response.json({ items: ids.map(id => ({ projectId: id, nodeId: node, runtimeId: rows[id - 1]?.runtimeId, name: `Owned ${id}`, rootPath: '/owner' })) })
  })
  vi.stubGlobal('fetch', fetch)
  const { result } = renderHook(() => useProjectChoices())
  act(() => result.current.setProjects(rows))
  expect(fetch).not.toHaveBeenCalled()
  act(() => result.current.readNames([34, 36]))
  await waitFor(() => expect(result.current.projects[33]?.name).toBe('Owned 34'))
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(new URL(fetch.mock.calls[0]![0], 'https://qa.invalid').searchParams.get('ids')).toBe('34,36')
  expect(result.current.projects[33]?.path).toBe('')
  fetch.mockResolvedValueOnce(Response.json({ error: 'forbidden' }, { status: 403 }))
  act(() => result.current.readNames([39]))
  await waitFor(() => expect(result.current.projects[33]?.name).toBe('#34'))
  expect(result.current.projects.every(row => !row.ownerDisplayLoaded)).toBe(true)
})
