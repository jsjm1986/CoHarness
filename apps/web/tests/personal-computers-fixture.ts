/** Two real personal Hosts behind the account directory, with eighteen additional cold computers. @module */
import { createServer, request } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { launchWebScaffold, seedSession, type WebScaffold } from './scaffold.ts'

type DraftValue = { revision: number; text: string }
type HostReplay = { file: string; children: string[] }
interface FixtureDraftStore {
  apply(key: {
    organizationId: string
    nodeId: string
    userId: number
    runtimeId: string
    target: string
    sessionId: string
    draftId: string
  },
    operation: { kind: 'read'; revision?: number } | { kind: 'save'; value: DraftValue }): Promise<{ status: 200; value: DraftValue } | { status: 409 | 410 }>
  close(): Promise<void>
}

/** Stable browser identities used by the personal-directory scenario. */
export const personalTargets = Array.from({ length: 20 }, (_, i) => ({ kind: 'personal' as const,
  runtimeId: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  nodeId: `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  nodeName: i === 0 ? 'Office computer' : i === 1 ? 'Compute computer' : `Computer ${i + 1}` }))

/**
 * Start real Web profiles; only account discovery is supplied by the fixture router.
 * @returns owned servers, directory counters and quiescent cleanup.
 */
export async function launchPersonalComputersFixture(
  options: { localReplay?: HostReplay; remoteReplay?: HostReplay; workbench?: boolean; projectMetadata?: boolean } = {},
) {
  const worlds: WebScaffold[] = [], sockets = new Set<Socket>(), requests = new Set<ReturnType<typeof request>>()
  const cookies = new Map<string, string>(), calls = new Map<string, number>(), preparations = new Map<string, number>()
  const source = new URL('../../../gateway/src/node-drafts.ts', import.meta.url)
  const { LocalNodeDrafts } = await import(/* @vite-ignore */ source.href) as {
    LocalNodeDrafts: new (directory: string) => FixtureDraftStore
  }
  const draftStores: FixtureDraftStore[] = []
  const draftSlots = new Map<string, number>()
  const draftReceipts: { node: number; slot: number; method?: string; status: number; revision?: number; hasText?: boolean }[] = []
  const passive = new Map<string, number>()
  const projectReads: number[][] = []
  const placed = options.projectMetadata ? personalTargets.slice(0, 2).map((computer, i) => ({
    projectId: 17 + i, nodeId: computer.nodeId, nodeName: computer.nodeName, runtimeId: `30000000-0000-4000-8000-00000000000${i + 1}`,
    name: i ? 'Compute project' : 'Office project', rootPath: i ? '/srv/compute/owned' : '/srv/office/owned',
  })) : []
  let latencyMs = 0
  const receipts: { path: string; runtimeId: string; requestAt: number; responseAt: number; status: number }[] = []
  const eventStreams = new Map<Socket, string>()
  const socketErrors: Error[] = []
  const observeSocket = (socket: Socket): void => {
    sockets.add(socket)
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') socketErrors.push(error)
      socket.destroy()
    })
    socket.on('close', () => { sockets.delete(socket) })
  }
  let server: ReturnType<typeof createServer> | undefined
  const close = async (): Promise<void> => {
    for (const pending of requests) pending.destroy()
    for (const socket of sockets) socket.destroy()
    if (server !== undefined) await new Promise<void>((resolve, reject) => {
      server?.close((error) => { if (error) reject(error); else resolve() })
    })
    const drained = await Promise.allSettled(draftStores.map(store => store.close()))
    const results = [...drained, ...await Promise.allSettled(worlds.map(world => world.close()))]
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    failures.push(...socketErrors)
    if (failures.length) { for (const failure of failures) if (failure instanceof AggregateError) console.error('Host teardown', failure.errors.map(String)); throw new AggregateError(failures, 'Personal-computer fixture cleanup failed') }
  }
  try {
    const seed = await readFile(fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url)), 'utf8')
    const groups = personalTargets.map(runtime => ({ runtime, status: 'active', observedState: 'stopped', syncedAt: null as string | null, items: [] as Array<{ workspaceId: string; path: string; title: string; sessionIds: readonly string[]; createdAt: string; updatedAt: string }> }))
    for (let i = 0; i < 2; i++) {
      const replay = i === 0 ? options.localReplay : options.remoteReplay
      const world = await launchWebScaffold({ openInApp: false,
        ...(options.workbench === undefined ? {} : { workbench: options.workbench }),
        ...(replay === undefined ? {} : { replayFixture: replay.file, replayChildFixtures: replay.children, paceMs: 0 }) })
      draftStores.push(new LocalNodeDrafts(world.workspaceCwd))
      worlds.push(world)
      const titled = seed.split('\n').map((line) => {
        if (line === '') return line
        const event = JSON.parse(line) as { type: string; data?: object }
        return event.type === 'session/title' ? JSON.stringify({ ...event, data: { ...event.data, messageSeqs: [], title: i === 0 ? 'Office conversation' : 'Compute conversation', source: { kind: 'user' } } }) : line
      }).join('\n')
      const id = await seedSession(world, titled, 'same-personal-session')
      const workspace = await world.ctx.workspaceRegistry.create(world.workspaceCwd)
      await workspace.attachSession(id)
      await workspace.setTitle(i === 0 ? 'Office work' : 'Compute work')
      const record = workspace
      Object.assign(groups[i]!, { syncedAt: '2026-10-30T00:00:00.000Z',
        items: [{ workspaceId: workspace.id, path: record.path, title: i === 0 ? 'Office work' : 'Compute work', sessionIds: [id],
          createdAt: record.createdAt, updatedAt: record.updatedAt }] })
    }
    const selected = (raw?: string): number => new URL(raw ?? '/', 'http://fixture').searchParams.get('dshRuntime') === personalTargets[1]!.runtimeId ? 1 : 0
    server = createServer((req, res) => {
      const serve = async (): Promise<void> => {
        const url = new URL(req.url ?? '/', 'http://fixture'), index = selected(req.url), world = worlds[index]!, target = personalTargets[index]!
        const reply = (value: unknown): void => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
        const requested = url.searchParams.get('dshRuntime')
        const prepared = url.pathname.startsWith('/api/prepare/v1/') || url.pathname.startsWith('/api/admit/v1/')
        const measured = prepared || url.pathname === '/account/api/workbench/rows' || url.pathname.startsWith('/account/api/drafts/')
        const requestAt = performance.now()
        if (prepared && (typeof req.headers['x-dsh-operation-id'] !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(req.headers['x-dsh-operation-id']))) {
          res.writeHead(400); res.end(); return
        }
        if (measured) {
          res.once('finish', () => { receipts.push({ path: url.pathname, runtimeId: requested ?? '', requestAt, responseAt: performance.now(), status: res.statusCode }) })
          if (req.headers['x-dsh-expected-principal-id'] !== '7' || url.searchParams.get('dshTarget') !== 'personal'
          || !personalTargets.some(row => row.runtimeId === requested)) { res.writeHead(403); res.end(); return }
        }
        if ((url.pathname.startsWith('/api/') || url.pathname.startsWith('/account/api/')) && latencyMs > 0) {
          await new Promise<void>(resolve => setTimeout(resolve, latencyMs))
          if (res.destroyed) return
        }
        if (url.pathname === '/account/api/workbench/rows') {
          const at = personalTargets.findIndex(row => row.runtimeId === requested)
          const group = groups[at]!
          passive.set(requested!, (passive.get(requested!) ?? 0) + 1)
          const items = at >= 0 && at < worlds.length ? [{ sessionId: 'same-personal-session', runtime: group.runtime,
            title: at === 0 ? 'Office conversation' : 'Compute conversation', cwd: worlds[at]!.workspaceCwd,
            visibility: 'personal', creatorUserId: 7, creatorDisplayName: 'Lin', updatedAt: 1, blank: false, canWrite: true }] : []
          const conversations = { runtimeId: requested, items, workspaces: [], nextCursor: null }
          reply(url.searchParams.get('kind') === 'conversations' ? conversations
            : { runtimeId: requested, items: [], workspaces: group.items, nextCursor: null,
              ...(url.searchParams.get('include') === 'conversations' ? { conversationPage: conversations } : {}) }); return
        }
        if (url.pathname.startsWith('/account/api/drafts/')) {
          if (req.headers['x-dsh-expected-principal-id'] !== '7' || requested !== target.runtimeId || url.searchParams.get('dshTarget') !== 'personal') {
            res.writeHead(403); res.end(); return
          }
          const key = { organizationId: 'test', nodeId: target.nodeId, userId: 7,
            runtimeId: target.runtimeId, target: 'personal', sessionId: url.searchParams.get('sessionId') ?? '',
            draftId: url.pathname.slice('/account/api/drafts/'.length) }
          let body = ''
          for await (const part of req) body += String(part)
          const revision = url.searchParams.get('revision')
          const operation = req.method === 'GET' ? { kind: 'read' as const, ...(revision === null ? {} : { revision: Number(revision) }) } : { kind: 'save' as const,
            value: { ...JSON.parse(body) as { revision: number; text?: string }, ...(req.method === 'DELETE' ? { text: '' } : {}) } }
          const result = await draftStores[index]!.apply(key, operation.kind === 'read' ? operation : { kind: 'save', value: { revision: operation.value.revision, text: operation.value.text ?? '' } })
          let slot = draftSlots.get(key.draftId)
          if (slot === undefined) { slot = draftSlots.size + 1; draftSlots.set(key.draftId, slot) }
          draftReceipts.push({ node: index, slot, ...(req.method ? { method: req.method } : {}), status: result.status,
            ...(result.status === 200 ? { revision: result.value.revision, hasText: result.value.text !== '' } : {}) })
          res.setHeader('x-dsh-runtime-id', target.runtimeId)
          if (result.status === 200) reply(result.value)
          else { res.writeHead(result.status); res.end() }
          return
        }
        if (prepared && requested !== target.runtimeId) { res.writeHead(503); res.end(); return }
        if (url.pathname === '/account/api/deployment/context') {
          const entry = { nodeId: personalTargets[0]!.nodeId, name: personalTargets[0]!.nodeName }
          reply({ mode: 'multi', revision: '1', entry, primary: { ...entry, origin: `http://127.0.0.1:${req.socket.localPort}` },
            role: 'primary', scope: 'organization', refreshAfterMs: 30000, legacyMigrationRequired: false }); return
        }
        if (url.pathname === '/account/api/context') {
          reply({ user: { id: 7, username: 'lin', displayName: 'Lin', role: 'member' }, scope: { kind: 'personal' },
            projects: placed.map(({ projectId, nodeId, nodeName }) => ({ projectId, nodeId, nodeName, mode: 'rw', metadataOnNode: true, name: 'unverified control-plane name', path: '/unverified' })),
            environment: { id: target.runtimeId, nodeId: target.nodeId, nodeName: target.nodeName } }); return
        }
        if (url.pathname === '/account/api/project-metadata') {
          const ids = (url.searchParams.get('ids') ?? '').split(',').map(Number)
          const authorized = placed.filter(row => row.nodeId === url.searchParams.get('dshNode') && ids.includes(row.projectId))
          if (req.headers['x-dsh-expected-principal-id'] !== '7' || !authorized.length || authorized.length !== ids.length) { res.writeHead(403); res.end(); return }
          projectReads.push(ids)
          reply({ items: authorized }); return
        }
        if (url.pathname === '/account/api/workbench/catalog') {
          reply({ personalComplete: false, personal: { id: 7, name: 'Personal' }, activeRuntime: target, projects: [], personalWorkspaces: groups,
            items: personalTargets.slice(0, 2).map((runtime, i) => ({ sessionId: 'same-personal-session', runtime,
              title: i === 0 ? 'Office conversation' : 'Compute conversation', cwd: worlds[i]!.workspaceCwd,
              visibility: 'personal', creatorUserId: 7, creatorDisplayName: 'Lin', updatedAt: 1, blank: false, canWrite: true })) }); return
        }
        if (url.pathname === '/account/api/runtimes') {
          reply({ items: [...personalTargets.map(runtime => ({ id: runtime.runtimeId, owner: { kind: 'personal', id: 7, name: 'Lin' },
            node: { id: runtime.nodeId, name: runtime.nodeName, status: 'active', lastHeartbeatAt: null }, routing: 'local', observedState: 'stopped', generation: 1 })),
          ...placed.map(row => ({ id: row.runtimeId, owner: { kind: 'project', id: row.projectId, name: 'unverified control-plane name' }, metadataOnNode: true,
            node: { id: row.nodeId, name: row.nodeName, status: 'active', lastHeartbeatAt: null }, routing: 'local', observedState: 'stopped', generation: 1 }))], nextCursor: null }); return
        }
        if (url.pathname === '/account/api/scope' && req.method === 'POST') {
          const runtimeId = url.searchParams.get('dshRuntime')
          if (runtimeId === null || !personalTargets.slice(0, worlds.length).some(runtime => runtime.runtimeId === runtimeId)) {
            res.writeHead(404); res.end(); return
          }
          preparations.set(runtimeId, (preparations.get(runtimeId) ?? 0) + 1)
          res.writeHead(204, { location: `/?dshRuntime=${runtimeId}` }); res.end(); return
        }
        if (url.pathname.startsWith('/account/')) { res.writeHead(501, { 'content-type': 'application/json' }); res.end('{"error":"fixture-endpoint-unavailable"}'); return }
        if (url.pathname.startsWith('/api/')) calls.set(target.runtimeId, (calls.get(target.runtimeId) ?? 0) + 1)
        const upstream = request(new URL(req.url ?? '/', world.baseUrl), { method: req.method,
          headers: { ...req.headers, cookie: cookies.get(world.baseUrl) ?? '', ...(url.pathname === '/api/host.describe' ? { 'accept-encoding': 'identity' } : {}) } }, (response) => {
          if (url.pathname === '/api/host.describe') {
            response.setEncoding('utf8'); let body = ''
            response.on('data', (chunk: string) => { body += chunk })
            response.on('end', () => {
              const envelope = JSON.parse(body) as { result: { ok: boolean
                value?: { runtimeTarget?: unknown; executionAuthorityRequired?: boolean } } }
              if (envelope.result.value !== undefined) {
                Object.assign(envelope.result.value, { runtimeTarget: target, executionAuthorityRequired: true })
              }
              res.writeHead(response.statusCode ?? 502, { 'content-type': 'application/json' }); res.end(JSON.stringify(envelope))
            }); return
          }
          res.writeHead(response.statusCode ?? 502, { ...response.headers, ...(prepared ? { 'x-dsh-runtime-id': target.runtimeId } : {}) }); response.pipe(res)
        })
        requests.add(upstream); upstream.on('close', () => { requests.delete(upstream) })
        upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
        req.pipe(upstream)
      }
      void serve().catch((error: unknown) => {
        console.error('Isolated personal-computer route failed', req.method, new URL(req.url ?? '/', 'http://fixture').pathname, error)
        if (!res.headersSent) res.writeHead(500)
        res.end('Isolated route failed')
      })
    })
    server.on('connection', observeSocket)
    server.on('upgrade', (req, socket, head) => {
      const world = worlds[selected(req.url)]!
      const upstream = request(new URL(req.url ?? '/', world.baseUrl), { headers: { ...req.headers, cookie: cookies.get(world.baseUrl) ?? '' } })
      requests.add(upstream); upstream.on('close', () => { requests.delete(upstream) })
      upstream.on('error', () => { socket.destroy() })
      upstream.on('upgrade', (response, peer, peerHead) => {
        observeSocket(peer)
        if (/^\/api\/events\.(?:mux|host)$/u.test(new URL(req.url ?? '/', 'http://fixture').pathname)) {
          eventStreams.set(peer, personalTargets[selected(req.url)]!.runtimeId)
          peer.on('close', () => { eventStreams.delete(peer) })
        }
        const headers = response.rawHeaders.reduce<string[]>((lines, name, i, all) => i % 2 === 0 ? [...lines, `${name}: ${all[i + 1] ?? ''}`] : lines, [])
        socket.write(`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? 'Switching Protocols'}\r\n${headers.join('\r\n')}\r\n\r\n`)
        if (head.length) peer.write(head)
        if (peerHead.length) socket.write(peerHead)
        socket.pipe(peer).pipe(socket)
        socket.on('close', () => { peer.destroy() }); peer.on('close', () => { socket.destroy() })
      })
      upstream.end()
    })
    const port = Number(process.env['DSH_BROWSER_FIXTURE_PORT'] ?? '0')
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid loopback test fixture port')
    const entry = server
    await new Promise<void>((resolve, reject) => {
      entry.once('error', reject)
      entry.listen(port, '127.0.0.1', () => { entry.removeListener('error', reject); resolve() })
    })
    const authority = `127.0.0.1:${(server.address() as AddressInfo).port}`
    for (const world of worlds) {
      const exchange = new URL(world.ctx.connection.authenticatedUrl(`http://${authority}`))
      let cookie: string | undefined
      world.ctx.connection.authorizeIndex({ method: 'GET', url: `${exchange.pathname}${exchange.search}`, headers: { host: authority } }, {
        writeHead(_status, headers) { cookie = headers?.['set-cookie'] }, end() {},
      })
      if (cookie === undefined) throw new Error('Fixture router token exchange did not set a cookie')
      cookies.set(world.baseUrl, cookie.split(';', 1)[0]!)
    }
    return { worlds, calls, preparations, passive, receipts, projectReads, draftReceipts, setLatency: (ms: number) => { latencyMs = ms }, url: `http://${authority}/?dshRuntime=${personalTargets[0]!.runtimeId}`,
      renewEventStreams: (runtimeId: string): void => {
        for (const [socket, owner] of eventStreams) if (owner === runtimeId) socket.destroy()
      }, close }
  } catch (error) { await close(); throw error }
}
