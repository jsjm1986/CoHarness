import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createBrowserDocumentHandler } from '../src/browser-documents.ts'
import { checkDocumentAttachmentTarget } from '../src/node-content-documents-target.ts'
import { mergeDocumentOverview, type DocumentOverviewPage, type MergedDocumentOverview } from '../src/node-content-documents-overview.ts'
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

it.each(['ready', 'revoked', 'cancelled'] as const)('streams a local first page while the remote read is %s', async outcome => {
  const local = row('z-local-report.txt', source)
  const remoteRow = row('a-remote-report.txt', target)
  const reads: Array<[string, number]> = []
  let release = () => {}
  const pending = new Promise<void>(resolve => { release = resolve })
  let slowStarted = () => {}
  const started = new Promise<void>(resolve => { slowStarted = resolve })
  let remoteClosed = () => {}
  const closed = new Promise<void>(resolve => { remoteClosed = resolve })
  let authorized = true
  const handler = createBrowserDocumentHandler({
    transfer: {} as Parameters<typeof createBrowserDocumentHandler>[0]['transfer'],
    organizationId: org, origin: 'https://synthetic.test', responseLimit: 16384,
    overviewConcurrency: 2, overviewDeadlineMs: 125, overviewTimeoutMs: 10000,
    locations: { page: async () => ({ items: [], nextCursor: null }), resolve: async () => { throw new Error('unexpected') } },
    overview: { overview: async (_actor, opts, _all, fetchNode, signal, concurrency, progress) => mergeDocumentOverview(
      { organizationId: org, userId: actor.id, entryNodeId: source }, opts ?? {}, [
        { id: source, read: async offset => {
          reads.push([source, offset])
          return { documents: offset === 0 ? [local] : [], totalDocuments: 1, metrics }
        } },
        { id: target, read: (offset, limit, lifetime) => fetchNode!(target, offset, limit, lifetime) },
      ], concurrency ?? 2, signal, progress,
    ) },
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture')
    if (url.pathname === '/account/api/node-document-overview') {
      const offset = Number(url.searchParams.get('offset'))
      reads.push([target, offset])
      res.once('close', remoteClosed)
      slowStarted()
      void pending.then(() => {
        if (res.destroyed) return
        res.setHeader('x-dsh-target-node', target)
        res.end(JSON.stringify({ documents: offset === 0 ? [remoteRow] : [], metrics, totalDocuments: 1 }))
      })
      return
    }
    const abort = new AbortController()
    res.once('close', () => { if (!res.writableEnded) abort.abort() })
    void handler(req, actor, 'overview', { limit: 1, sort: 'name-asc', cursor: url.searchParams.get('cursor') ?? undefined },
      abort.signal, { response: res, authorize: async () => authorized }).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const controller = new AbortController()
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback listener required')
    const url = new URL(`http://127.0.0.1:${address.port}/test`)
    const response = await fetch(url, { signal: controller.signal })
    expect(response.headers.get('content-type')).toBe('application/x-ndjson')
    await started
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    try {
      while (!text.includes('\n')) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error('missing provisional page')
        text += decoder.decode(chunk.value, { stream: true })
      }
      expect(JSON.parse(text)).toMatchObject({ type: 'progress', pending: 1,
        page: { documents: [{ name: local.name }], totalDocuments: 1 } })
      expect(JSON.parse(text).page.nextCursor).toBeUndefined()
      expect(reads).toEqual([[source, 0], [target, 0]])
      if (outcome === 'cancelled') {
        await reader.cancel()
        await closed
        return
      }
      authorized = outcome === 'ready'
      release()
      text = ''
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
      }
    } finally { reader.releaseLock() }
    if (outcome === 'revoked') {
      expect(JSON.parse(text)).toMatchObject({ type: 'error', status: 403 })
      expect(text).not.toContain(remoteRow.name)
      return
    }
    const complete = JSON.parse(text) as { type: string; page: MergedDocumentOverview }
    expect(complete).toMatchObject({ type: 'complete', page: { documents: [{ name: remoteRow.name }], totalDocuments: 2 } })
    expect(complete.page.nextCursor).toBeDefined()
    url.searchParams.set('cursor', complete.page.nextCursor!)
    const next = JSON.parse(await (await fetch(url)).text()) as { type: string; page: MergedDocumentOverview }
    expect(next).toMatchObject({ type: 'complete', page: { documents: [{ name: local.name }], totalDocuments: 2 } })
    expect(next.page.nextCursor).toBeUndefined()
    expect(reads).toEqual([[source, 0], [target, 0], [source, 0], [target, 1]])
  } finally {
    release()
    controller.abort()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('keeps a missing computer outside the current page sequence until the next first-page query', async () => {
  const first = row('b-local.txt', source), second = row('c-local.txt', source), remote = row('a-returned.txt', target)
  let available = false
  const reads: string[] = []
  const sources = [
    { id: source, read: async (offset: number, limit: number) => ({ documents: [first, second].slice(offset, offset + limit), totalDocuments: 2, metrics }) },
    { id: target, read: async () => {
      reads.push(target)
      if (!available) throw new Error('synthetic outage')
      return { documents: [remote], totalDocuments: 1, metrics }
    } },
  ]
  const owner = { organizationId: org, userId: actor.id, entryNodeId: source }
  const options = { limit: 1, sort: 'name-asc' as const }
  const progress = async () => {}
  const page = await mergeDocumentOverview(owner, options, sources, 2, undefined, progress)
  expect(page.documents).toEqual([first])
  expect(page.unavailableNodes).toEqual([target])
  expect(page.nextCursor).toBeDefined()
  available = true
  const continued = await mergeDocumentOverview(owner, { ...options, cursor: page.nextCursor! }, sources, 2, undefined, progress)
  expect(continued).toMatchObject({ documents: [second], unavailableNodes: [target] })
  expect(continued.nextCursor).toBeUndefined()
  expect(reads).toEqual([target])
  const refreshed = await mergeDocumentOverview(owner, options, sources, 2, undefined, progress)
  expect(refreshed.documents).toEqual([remote])
  expect(refreshed.partial).toBeUndefined()
  expect(reads).toEqual([target, target])
})

it('requests only a page per computer from a 1,600-document directory', async () => {
  const pageSize = 20, reads: Array<[number, number]> = []
  const names = Array.from({ length: 1600 }, (_, index) => `report-${String(index).padStart(4, '0')}.txt`)
  const sources = Array.from({ length: 20 }, (_, node) => {
    const id = randomUUID()
    const documents = Array.from({ length: 80 }, (_, index) => row(names[index * 20 + node]!, id))
    return { id, read: async (offset: number, limit: number) => {
      reads.push([offset, limit])
      return { documents: documents.slice(offset, offset + limit), totalDocuments: documents.length, metrics, revision: 'a'.repeat(64) }
    } }
  })
  const owner = { organizationId: org, userId: actor.id, entryNodeId: source }
  const options = { limit: pageSize, sort: 'name-asc' as const }
  const progress = async (update: MergedDocumentOverview) => { expect(update.documents.length).toBeLessThanOrEqual(pageSize) }
  const first = await mergeDocumentOverview(owner, options, sources, 5, undefined, progress)
  expect(first.totalDocuments).toBe(1600)
  expect(first.documents.map(doc => doc.name)).toEqual(names.slice(0, 20))
  expect(first.nextCursor!.length).toBeLessThanOrEqual(4096)
  const next = await mergeDocumentOverview(owner, { ...options, cursor: first.nextCursor! }, sources, 5, undefined, progress)
  expect(next.documents.map(doc => doc.name)).toEqual(names.slice(20, 40))
  expect(reads).toEqual([...Array.from({ length: 20 }, () => [0, pageSize]), ...Array.from({ length: 20 }, () => [1, pageSize])])
})

it('reads or creates only the requested folder operation after pure validation and current authorization', async () => {
  const calls: string[] = []
  const admissions: string[] = []
  let allowed = true
  const portfolio = createBrowserDocumentHandler({
    transfer: {} as Parameters<typeof createBrowserDocumentHandler>[0]['transfer'],
    organizationId: org, origin: 'https://synthetic.test', responseLimit: 16384,
    locations: {
      page: async () => ({ items: [], nextCursor: null }),
      resolve: async (_actor, scope, action) => {
        admissions.push(action)
        if (!allowed) throw Object.assign(new Error('denied'), { status: 403 })
        return { scope: scope as never, name: 'test', nodeName: 'test', mode: 'rw' }
      },
    },
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture')
    if (url.pathname.startsWith('/api/documents/')) {
      calls.push(req.method + ' ' + url.pathname)
      expect(url.searchParams.get('dshNode')).toBe(target)
      expect(url.searchParams.get('scope')).toBe('project:41')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(url.pathname.endsWith('directories') ? { directories: [] } : { directoryId: 'new', name: 'new' }))
      return
    }
    const operation = url.searchParams.get('op') ?? 'directories'
    const payload = url.searchParams.has('bad') ? { version: 1, scope: { kind: 'project', projectId: 41, nodeId: '../wrong' } }
      : { version: 1, scope: { kind: 'project', projectId: 41, nodeId: target }, directory: '', name: 'new' }
    void portfolio(req, actor, operation, payload, new AbortController().signal).then(
      value => res.end(JSON.stringify(value)),
      (error: { status?: number }) => res.writeHead(error.status ?? 500).end(),
    )
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback listener required')
    const base = 'http://127.0.0.1:' + address.port
    expect((await fetch(base + '/test')).status).toBe(200)
    expect((await fetch(base + '/test?op=directories/create')).status).toBe(200)
    expect(calls).toEqual(['GET /api/documents/scope/directories', 'POST /api/documents/scope/folders'])
    expect(admissions).toEqual(['read', 'write'])
    expect((await fetch(base + '/test?bad=1')).status).toBe(400)
    allowed = false
    expect((await fetch(base + '/test')).status).toBe(403)
    expect(calls).toHaveLength(2)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
