import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import {
  createDocumentTransferCapabilitiesHandler,
  createDocumentTransferListHandler,
  createDocumentTransferHandler,
  DocumentTransferError,
} from '../src/document-transfer.ts'
import type { GatewayPrincipalClaims } from '../src/principal.ts'
import { GatewayPrincipalSigner } from '../src/principal.ts'
import type { RuntimeCredentialSubject } from '../src/runtime-api.ts'

const USER: UserRow = {
  id: 7,
  username: 'lin',
  displayName: 'Lin',
  role: 'user',
  status: 'active',
  homePath: '/tmp/lin',
  mustChangePassword: false,
}

const PRINCIPAL: GatewayPrincipalClaims = {
  version: 1,
  issuer: 'harness-gateway',
  audience: 'dsh-runtime',
  organization: 'acme',
  user: { id: USER.id, username: USER.username, displayName: USER.displayName, role: USER.role },
  scope: { kind: 'personal' },
  runtime: { kind: 'user', id: USER.id, generation: 1 },
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
  nonce: 'test',
}

const SUBJECT: RuntimeCredentialSubject = {
  organizationId: 'org',
  target: { kind: 'user', id: USER.id },
  generation: 1,
  userInternalId: 'user-internal',
}

function fixture() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const principals = new GatewayPrincipalSigner(privateKey, 'acme', 60_000)
  const audit = vi.fn(async () => {})
  const projectForUser = vi.fn(async (projectId: number) => projectId === 41
    ? { projectId, name: 'Compiler', path: '/tmp/compiler', mode: 'rw' as const, administrator: false }
    : projectId === 42
      ? { projectId, name: 'Read only', path: '/tmp/readonly', mode: 'ro' as const, administrator: false }
      : null)
  const ensureRunning = vi.fn(async (subject: UserRow | { kind: 'project'; id: number; name: string; path: string }) =>
    'username' in subject ? { port: 41001, generation: 1 } : { port: subject.id === 41 ? 41041 : 41042, generation: 2 })
  const handler = createDocumentTransferHandler({
    instances: { ensureRunning },
    users: { getById: async () => USER },
    projects: { getById: async (id) => id === 41
      ? { id, name: 'Compiler', path: '/tmp/compiler', memberCount: 1, members: [] }
      : { id, name: 'Read only', path: '/tmp/readonly', memberCount: 1, members: [] } },
    collaboration: {
      projectForUser,
      projectsForUser: async () => [
        { projectId: 41, name: 'Compiler', path: '/tmp/compiler', mode: 'rw' as const },
        { projectId: 42, name: 'Read only', path: '/tmp/readonly', mode: 'ro' as const },
      ],
    },
    principals,
    audit: { write: audit },
  })
  const collaboration = {
    projectForUser,
    projectsForUser: async () => [
      { projectId: 41, name: 'Compiler', path: '/tmp/compiler', mode: 'rw' as const },
      { projectId: 42, name: 'Read only', path: '/tmp/readonly', mode: 'ro' as const },
    ],
  }
  const capabilities = createDocumentTransferCapabilitiesHandler({ collaboration })
  const list = createDocumentTransferListHandler({
    instances: { ensureRunning },
    users: { getById: async () => USER },
    projects: { getById: async (id) => ({ id, name: 'Compiler', path: '/tmp/compiler', memberCount: 1, members: [] }) },
    collaboration,
    principals,
  })
  return { handler, capabilities, list, audit, ensureRunning, projectForUser }
}

function responseForTarget(docId: string, name = 'report.txt'): Response {
  return new Response(JSON.stringify({
    docId,
    path: '/private/should-not-leak',
    name,
    bytes: 5,
    mediaType: 'text/plain',
    modifiedAt: 10,
  }), { status: 201, headers: { 'content-type': 'application/json' } })
}

describe('Gateway document transfer broker', () => {
  it('streams a personal snapshot into a rw project and returns no host path', async () => {
    const runtime = fixture()
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('hello', {
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-length': '5' },
      }))
      .mockResolvedValueOnce(responseForTarget('report (2).txt', 'report (2).txt'))
    vi.stubGlobal('fetch', fetch)
    const result = await runtime.handler({
      request: {} as never,
      subject: SUBJECT,
      principal: PRINCIPAL,
      payload: {
        version: 1,
        source: { kind: 'personal' },
        target: { kind: 'project', projectId: 41 },
        documents: [{ docId: 'report.txt' }],
      },
      signal: new AbortController().signal,
    })

    expect(result.items).toMatchObject([{
      status: 'copied',
      source: { name: 'report.txt', bytes: 5, mediaType: 'text/plain' },
      target: { docId: 'report (2).txt', name: 'report (2).txt', bytes: 5 },
    }])
    expect(JSON.stringify(result)).not.toContain('/private/should-not-leak')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[0]).toContain('/api/documents?name=report.txt')
    expect(runtime.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'documents.transfer' }))
  })

  it('allows a ro project source to copy into personal scope', async () => {
    const runtime = fixture()
    const principal: GatewayPrincipalClaims = {
      ...PRINCIPAL,
      scope: { kind: 'project', projectId: 42, projectName: 'Read only', mode: 'ro' },
      runtime: { kind: 'project', id: 42, generation: 2 },
    }
    const subject: RuntimeCredentialSubject = {
      organizationId: 'org', target: { kind: 'project', id: 42 }, generation: 2,
      projectInternalId: 'project-internal',
    }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('hello', { status: 200, headers: { 'content-length': '5' } }))
      .mockResolvedValueOnce(responseForTarget('report.txt')))
    await expect(runtime.handler({
      request: {} as never, subject, principal,
      payload: {
        version: 1,
        source: { kind: 'project', projectId: 42 },
        target: { kind: 'personal' },
        documents: [{ docId: 'report.txt' }],
      },
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ source: { kind: 'project' }, target: { kind: 'personal' } })
  })

  it('rejects a personal copy into a read-only project before opening the source', async () => {
    const runtime = fixture()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(runtime.handler({
      request: {} as never,
      subject: SUBJECT,
      principal: PRINCIPAL,
      payload: {
        version: 1,
        source: { kind: 'personal' },
        target: { kind: 'project', projectId: 42 },
        documents: [{ docId: 'report.txt' }],
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COLLABORATION_FORBIDDEN', status: 403 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps a later file when an earlier source file is absent', async () => {
    const runtime = fixture()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'DOCUMENT_NOT_FOUND', message: 'missing' } }), { status: 404 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200, headers: { 'content-length': '2' } }))
      .mockResolvedValueOnce(responseForTarget('second.txt', 'second.txt')))
    const result = await runtime.handler({
      request: {} as never, subject: SUBJECT, principal: PRINCIPAL,
      payload: {
        version: 1,
        source: { kind: 'personal' },
        target: { kind: 'project', projectId: 41 },
        documents: [{ docId: 'missing.txt' }, { docId: 'second.txt' }],
      },
      signal: new AbortController().signal,
    })
    expect(result.items.map(item => item.status)).toEqual(['failed', 'copied'])
  })

  it('rejects project-to-project and malformed ids', async () => {
    const runtime = fixture()
    await expect(runtime.handler({
      request: {} as never, subject: SUBJECT, principal: PRINCIPAL,
      payload: {
        version: 1,
        source: { kind: 'project', projectId: 41 },
        target: { kind: 'project', projectId: 42 },
        documents: [{ docId: 'a.txt' }],
      },
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(DocumentTransferError)
    await expect(runtime.handler({
      request: {} as never, subject: SUBJECT, principal: PRINCIPAL,
      payload: {
        version: 1,
        source: { kind: 'personal' },
        target: { kind: 'project', projectId: 41 },
        documents: [{ docId: '../secret' }],
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_TRANSFER' })
  })

  it('projects only safe target labels and writable modes', async () => {
    const runtime = fixture()
    await expect(runtime.capabilities({ subject: SUBJECT, principal: PRINCIPAL })).resolves.toEqual({
      version: 1,
      current: { kind: 'personal', label: 'Personal documents' },
      targets: [
        { scope: { kind: 'project', projectId: 41 }, label: 'Compiler', canRead: true, canWrite: true },
        { scope: { kind: 'project', projectId: 42 }, label: 'Read only', canRead: true, canWrite: false },
      ],
    })
  })

  it('lists an authorized alternate project without returning its absolute paths', async () => {
    const runtime = fixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      documents: [{
        docId: 'reports/a.txt', path: '/private/source', name: 'a.txt', bytes: 1,
        mediaType: 'text/plain', modifiedAt: 1,
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const result = await runtime.list({
      subject: SUBJECT,
      principal: PRINCIPAL,
      payload: { version: 1, scope: { kind: 'project', projectId: 41 } },
    })
    expect(result.documents).toEqual([expect.objectContaining({ docId: 'reports/a.txt', name: 'a.txt' })])
    expect(JSON.stringify(result)).not.toContain('/private/source')
  })
})
