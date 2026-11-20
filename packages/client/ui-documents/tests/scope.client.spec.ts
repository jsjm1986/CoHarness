// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDocumentsScope, readDocumentsScope } from '../src/client/documents-client.ts'

describe('parseDocumentsScope', () => {
  it('treats missing or personal payloads as personal', () => {
    expect(parseDocumentsScope(null)).toEqual({ kind: 'personal' })
    expect(parseDocumentsScope('x')).toEqual({ kind: 'personal' })
    expect(parseDocumentsScope({})).toEqual({ kind: 'personal' })
    expect(parseDocumentsScope({ scope: null })).toEqual({ kind: 'personal' })
    expect(parseDocumentsScope({ scope: { kind: 'personal' } })).toEqual({ kind: 'personal' })
    expect(parseDocumentsScope({ scope: { kind: 'project' } })).toEqual({ kind: 'personal' })
    expect(parseDocumentsScope({ scope: { kind: 'project', projectName: '' } })).toEqual({ kind: 'personal' })
  })

  it('reads a named project scope', () => {
    expect(parseDocumentsScope({
      scope: { kind: 'project', projectName: '支付重构' },
    })).toEqual({ kind: 'project', projectName: '支付重构' })
  })
})

describe('readDocumentsScope', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns personal when the context route is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
    expect(await readDocumentsScope()).toEqual({ kind: 'personal' })
  })

  it('returns the decoded project when the context route succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ scope: { kind: 'project', projectName: '审计平台' } }),
    })))
    expect(await readDocumentsScope()).toEqual({ kind: 'project', projectName: '审计平台' })
  })

  it('returns personal when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await readDocumentsScope()).toEqual({ kind: 'personal' })
  })
})

describe('computer-owned document labels', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('keeps physical project names node-owned and validates each returned owner', async () => {
    const { readDocumentLocations, readDocumentProjectNames } = await import('../src/client/documents-client.ts')
    const node = '10000000-0000-4000-8000-000000000001'
    const request = vi.fn(async (input: string) => new Response(JSON.stringify(input.startsWith('/account/api/document-locations')
      ? { items: [{ name: '#41', metadataOnNode: true, scope: { kind: 'project', projectId: 41, nodeId: node }, nodeName: 'Computer', mode: 'rw' }], nextCursor: null }
      : { items: [{ projectId: 41, nodeId: node, name: 'Private project' }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', request)
    const signal = new AbortController().signal
    expect((await readDocumentLocations(signal))?.items[0]).toMatchObject({ metadataOnNode: true, name: '#41' })
    expect(await readDocumentProjectNames(node, [41], signal)).toEqual(new Map([[41, 'Private project']]))
    expect(request.mock.calls[1]?.[0]).toBe(`/account/api/project-metadata?dshNode=${node}&ids=41`)
    request.mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ projectId: 41, nodeId: 'wrong-computer', name: 'Wrong' }] })))
    await expect(readDocumentProjectNames(node, [41], signal)).rejects.toThrow('owner changed')
    request.mockResolvedValueOnce(new Response(JSON.stringify({ items: [] })))
    await expect(readDocumentProjectNames(node, [41], signal)).rejects.toThrow('incomplete')
  })
})
