import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createBrowserDocumentHandler } from '../src/browser-documents.ts'
import { checkDocumentAttachmentTarget } from '../src/node-content-documents-target.ts'
import { mergeDocumentOverview, type DocumentOverviewPage } from '../src/node-content-documents-overview.ts'
import type { WorkbenchRowReader } from '../src/workbench-rows.ts'
import type { GatewayRequestContext } from '../src/server.ts'
import type { UserRow } from '../src/auth.ts'
import type { PostgresDocumentCatalogService } from '../src/postgres/document-catalog-service.ts'

const org = randomUUID(),
  source = randomUUID(),
  target = randomUUID(),
  runtime = randomUUID()
const actor: UserRow = {
  id: 17,
  username: 'synthetic',
  displayName: 'Synthetic',
  role: 'user',
  status: 'active',
  homePath: '/synthetic/sample',
  mustChangePassword: false,
  autoReviewEligible: false,
}
const owner = { user: actor, scope: { kind: 'personal' }, environment: { id: runtime, nodeId: target } } as GatewayRequestContext
const metrics = {
  total: 1,
  active: 1,
  trash: 0,
  purged: 0,
  deleted: 0,
  personal: 1,
  project: 0,
  bytes: 1,
  operations24h: 0,
  failures24h: 0,
}
function row(name: string, node: string) {
  return {
    catalogId: randomUUID(),
    scope: {
      kind: 'personal' as const,
      id: actor.id,
      nodeId: node as import('../src/runtime-catalog.ts').RuntimeNodeId,
      label: 'personal',
    },
    docId: name,
    name,
    directoryId: '',
    bytes: 1,
    mediaType: 'text/plain',
    modifiedAt: 1,
    owner: null,
    identity: null,
    ownerSource: 'upload' as const,
    state: 'active' as const,
    trashId: null,
    trashedAt: null,
    restoredAt: null,
    purgeAfter: null,
    purgedAt: null,
    legacy: false,
    lineageRootId: null,
  }
}

it('rejects an unavailable exact composer before contacting either file endpoint', async () => {
  let listings = 0,
    checks = 0,
    fileRequests = 0
  const read: WorkbenchRowReader = async () => {
    listings++
    throw new Error('an exact check cannot search titles')
  }
  read.exactWritableSession = async (given, id) => {
    checks++
    expect(given.environment?.id).toBe(runtime)
    expect(id).toBe('same-session')
    return false
  }
  const portfolio = createBrowserDocumentHandler({
    transfer: {} as Parameters<typeof createBrowserDocumentHandler>[0]['transfer'],
    organizationId: org,
    origin: 'https://synthetic.test',
    responseLimit: 16384,
    locations: {
      page: async () => ({ items: [], nextCursor: null }),
      resolve: async (_actor, scope) => ({ scope: scope as never, name: 'test', nodeName: 'test', mode: 'rw' }),
    },
  })
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/account/api/workbench/rows')) {
      void checkDocumentAttachmentTarget(read, owner, new URL(req.url, 'http://localhost').searchParams).then(
        result => res.end(JSON.stringify(result)),
        (error: { status: number }) => res.writeHead(error.status).end(),
      )
    } else if (req.url === '/test') {
      void portfolio(
        req,
        actor,
        'copy',
        {
          version: 1,
          source: { kind: 'personal', nodeId: source },
          target: { kind: 'personal', nodeId: target, runtimeId: runtime },
          targetSessionId: 'same-session',
          documents: [{ docId: 'different.txt' }],
        },
        new AbortController().signal,
      ).then(
        () => res.end(),
        (error: { status: number; code: string }) => res.writeHead(error.status).end(error.code),
      )
    } else {
      fileRequests++
      res.writeHead(500).end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback listener required')
    const result = await fetch('http://127.0.0.1:' + address.port + '/test')
    expect(result.status).toBe(409)
    expect(await result.text()).toBe('DOCUMENT_ATTACHMENT_TARGET_UNAVAILABLE')
    expect({ checks, listings, fileRequests }).toEqual({ checks: 1, listings: 0, fileRequests: 0 })
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('returns local results under one foreground deadline when a connected HTTP peer never sends its response', async () => {
  const local: DocumentOverviewPage = { documents: [row('local.txt', source)], totalDocuments: 1, metrics }
  const overview = {
    overview: async (
      _actor: number,
      opts: Parameters<PostgresDocumentCatalogService['overview']>[1],
      _all: boolean,
      remote: NonNullable<Parameters<PostgresDocumentCatalogService['overview']>[3]>,
      signal: AbortSignal,
      concurrency: number,
    ) =>
      mergeDocumentOverview(
        { organizationId: org, userId: actor.id, entryNodeId: source },
        opts ?? {},
        [
          { id: source, read: async () => local },
          { id: target, read: (offset, limit, lifetime) => remote(target, offset, limit, lifetime) },
        ],
        concurrency,
        signal,
      ),
  } as Pick<PostgresDocumentCatalogService, 'overview'>
  const portfolio = createBrowserDocumentHandler({
    transfer: {} as Parameters<typeof createBrowserDocumentHandler>[0]['transfer'],
    organizationId: org,
    origin: 'https://synthetic.test',
    responseLimit: 16384,
    overviewConcurrency: 1,
    overviewDeadlineMs: 150,
    overview,
    locations: {
      page: async () => ({ items: [], nextCursor: null }),
      resolve: async () => {
        throw new Error('unexpected')
      },
    },
  })
  let slowRead = 0
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/account/api/node-document-overview')) {
      slowRead++
      return
    }
    void portfolio(req, actor, 'overview', {}, new AbortController().signal).then(
      value => res.end(JSON.stringify(value)),
      () => res.writeHead(500).end(),
    )
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback listener required')
    const started = performance.now()
    const result = await (await fetch('http://127.0.0.1:' + address.port + '/test')).json()
    expect(result).toMatchObject({
      documents: [{ name: 'local.txt' }],
      partial: true,
      unavailableNodes: [target],
      totalDocuments: 1,
    })
    expect(slowRead).toBe(1)
    console.info(
      'Synthetic non-responding peer with 150 ms aggregate budget, round trip, ms:',
      Math.round(performance.now() - started),
    )
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
