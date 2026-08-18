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
