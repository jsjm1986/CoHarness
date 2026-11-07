import { describe, expect, it, vi } from 'vitest'
import { createDocumentCatalogHandlers } from '../src/document-catalog.ts'
import type { GatewayPrincipalClaims } from '../src/principal.ts'
import type { RuntimeCredentialSubject } from '../src/runtime-api.ts'

const principal: GatewayPrincipalClaims = {
  version: 1,
  issuer: 'harness-gateway',
  audience: 'dsh-runtime',
  organization: 'acme',
  user: { id: 7, username: 'lin', displayName: 'Lin', role: 'user' },
  scope: { kind: 'project', projectId: 41, projectName: 'Compiler', mode: 'rw' },
  runtime: { kind: 'project', id: 41, generation: 1 },
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
  nonce: 'test',
}

const subject: RuntimeCredentialSubject = {
  organizationId: 'org',
  target: { kind: 'project', id: 41 },
  generation: 1,
  projectInternalId: 'project',
}

function fixture() {
  const catalog = {
    sync: vi.fn(async () => {}),
    markDeleted: vi.fn(async () => {}),
    authorize: vi.fn(async () => ({ allowed: true as const, selections: [
      { docId: 'a.txt', incarnationId: '11111111-1111-4111-8111-111111111111', revision: 2, state: 'active' as const },
    ] })),
    projectionCursor: vi.fn(async () => ({ sequence: 0, ordinal: 0 })),
    project: vi.fn(async (_actorUserId: number, _scope: unknown, batch: { next: { sequence: number; ordinal: number } }) => batch.next),
    overview: vi.fn(async () => ({ version: 1 as const, documents: [], metrics: {
      total: 0, active: 0, deleted: 0, personal: 0, project: 0, bytes: 0, operations24h: 0, failures24h: 0,
    } })),
    history: vi.fn(async () => []),
  }
  return { catalog, handlers: createDocumentCatalogHandlers(catalog) }
}

describe('runtime document catalog handlers', () => {
  it('derives the current project scope and accepts metadata without paths', async () => {
    const runtime = fixture()
    await expect(runtime.handlers.sync({
      subject, principal,
      payload: { version: 1, source: 'upload', documents: [{ docId: 'a.txt', name: 'a.txt', bytes: 3, mediaType: 'text/plain', modifiedAt: 4 }] },
    })).resolves.toEqual({ version: 1, accepted: 1 })
    expect(runtime.catalog.sync).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 7,
      scope: { kind: 'project', projectId: 41 },
      documents: [expect.objectContaining({ docId: 'a.txt' })],
    }))
  })

  it('rejects absolute paths and malformed metadata', async () => {
    const runtime = fixture()
    await expect(runtime.handlers.sync({
      subject, principal,
      payload: { version: 1, documents: [{ docId: '/etc/passwd', name: 'passwd', bytes: 1, mediaType: 'text/plain', modifiedAt: 1 }] },
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_METADATA', status: 400 })
  })

  it('passes ownership-aware authorization and exposes metadata-only overview', async () => {
    const runtime = fixture()
    await expect(runtime.handlers.authorize({
      subject, principal, payload: { version: 1, action: 'delete', docIds: ['a.txt'] },
    })).resolves.toEqual({ version: 1, allowed: true, selections: [
      { docId: 'a.txt', incarnationId: '11111111-1111-4111-8111-111111111111', revision: 2, state: 'active' },
    ] })
    await expect(runtime.handlers.overview({ subject, principal })).resolves.toMatchObject({ version: 1, documents: [] })
    expect(runtime.catalog.authorize).toHaveBeenCalledWith({ actorUserId: 7, scope: { kind: 'project', projectId: 41 }, action: 'delete',
      documents: [{ docId: 'a.txt' }], administrator: false })
  })

  it('uses the provider batch deletion path when a runtime sends removed ids', async () => {
    const runtime = fixture()
    const markDeletedBatch = vi.fn(async () => {})
    ;(runtime.catalog as typeof runtime.catalog & { markDeletedBatch?: typeof markDeletedBatch }).markDeletedBatch = markDeletedBatch
    await expect(runtime.handlers.sync({
      subject, principal,
      payload: { version: 1, documents: [], removed: ['a.txt', 'b.txt'] },
    })).resolves.toEqual({ version: 1, accepted: 0 })
    expect(markDeletedBatch).toHaveBeenCalledWith(7, { kind: 'project', projectId: 41 }, [{ docId: 'a.txt' }, { docId: 'b.txt' }])
    expect(runtime.catalog.markDeleted).not.toHaveBeenCalled()
  })

  it('requires the exact lifecycle backend for permanent purge', async () => {
    const runtime = fixture()
    const payload = { version: 1, documents: [{ docId: 'a.txt', incarnationId: '11111111-1111-4111-8111-111111111111',
      revision: 2, trashId: '22222222-2222-4222-8222-222222222222' }] }
    await expect(runtime.handlers.purge({ subject, principal, payload }))
      .rejects.toMatchObject({ code: 'DOCUMENT_CATALOG_UNAVAILABLE', status: 503 })

    const markDeletedBatch = vi.fn(async () => {})
    ;(runtime.catalog as typeof runtime.catalog & { markDeletedBatch?: typeof markDeletedBatch }).markDeletedBatch = markDeletedBatch
    await expect(runtime.handlers.purge({ subject, principal, payload })).resolves.toEqual({ version: 1, accepted: 1 })
    expect(markDeletedBatch).toHaveBeenCalledWith(7, { kind: 'project', projectId: 41 }, [{
      docId: 'a.txt', incarnationId: '11111111-1111-4111-8111-111111111111', revision: 3,
      trashId: '22222222-2222-4222-8222-222222222222', state: 'purged',
    }])
  })
})
