/** Two real personal Hosts behind the account directory, with eighteen additional cold computers. @module */
import { createServer, request } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { launchWebScaffold, seedSession, type WebScaffold } from './scaffold.ts'

/** Stable browser identities used by the personal-directory scenario. */
export const personalTargets = Array.from({ length: 20 }, (_, i) => ({ kind: 'personal' as const,
  runtimeId: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  nodeId: `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  nodeName: i === 0 ? 'Office computer' : i === 1 ? 'Compute computer' : `Computer ${i + 1}` }))

/**
 * Start real Web profiles; only account discovery is supplied by the fixture router.
 * @returns owned servers, directory counters and quiescent cleanup.
 */
export async function launchPersonalComputersFixture() {
  const worlds: WebScaffold[] = [], sockets = new Set<Socket>(), requests = new Set<ReturnType<typeof request>>()
  const cookies = new Map<string, string>(), calls = new Map<string, number>(), preparations = new Map<string, number>()
  const eventStreams = new Map<Socket, string>()
  let server: ReturnType<typeof createServer> | undefined
  const close = async (): Promise<void> => {
    for (const pending of requests) pending.destroy()
    for (const socket of sockets) socket.destroy()
    if (server !== undefined) await new Promise<void>((resolve, reject) => {
      server?.close((error) => { if (error) reject(error); else resolve() })
    })
    const results = await Promise.allSettled(worlds.map(world => world.close()))
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    if (failures.length) throw new AggregateError(failures, 'Personal-computer fixture cleanup failed')
  }
  try {
    const seed = await readFile(fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url)), 'utf8')
    const groups = personalTargets.map(runtime => ({ runtime, status: 'active', observedState: 'stopped', syncedAt: null as string | null, items: [] as Array<{ workspaceId: string; path: string; title: string; sessionIds: readonly string[]; createdAt: string; updatedAt: string }> }))
    for (let i = 0; i < 2; i++) {
      const world = await launchWebScaffold({ openInApp: false })
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
      const url = new URL(req.url ?? '/', 'http://fixture'), index = selected(req.url), world = worlds[index]!, target = personalTargets[index]!
      const reply = (value: unknown): void => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
      if (url.pathname === '/account/api/deployment/context') {
        const entry = { nodeId: personalTargets[0]!.nodeId, name: personalTargets[0]!.nodeName }
        reply({ mode: 'multi', revision: '1', entry, primary: { ...entry, origin: `http://127.0.0.1:${req.socket.localPort}` },
          role: 'primary', scope: 'organization', refreshAfterMs: 30000, legacyMigrationRequired: false }); return
      }
      if (url.pathname === '/account/api/context') {
        reply({ user: { id: 7, username: 'lin', displayName: 'Lin', role: 'member' }, scope: { kind: 'personal' }, projects: [],
          environment: { id: target.runtimeId, nodeId: target.nodeId, nodeName: target.nodeName } }); return
      }
      if (url.pathname === '/account/api/workbench/catalog') {
        reply({ personalComplete: false, personal: { id: 7, name: 'Personal' }, activeRuntime: target, projects: [], personalWorkspaces: groups,
          items: personalTargets.slice(0, 2).map((runtime, i) => ({ sessionId: 'same-personal-session', runtime,
            title: i === 0 ? 'Office conversation' : 'Compute conversation', cwd: worlds[i]!.workspaceCwd,
            visibility: 'personal', creatorUserId: 7, creatorDisplayName: 'Lin', updatedAt: 1, blank: false, canWrite: true })) }); return
      }
      if (url.pathname === '/account/api/runtimes') {
        reply({ items: personalTargets.map(runtime => ({ id: runtime.runtimeId, owner: { kind: 'personal', id: 7, name: 'Lin' },
          node: { id: runtime.nodeId, name: runtime.nodeName, status: 'active', lastHeartbeatAt: null }, routing: 'local', observedState: 'stopped', generation: 1 })), nextCursor: null }); return
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
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res)
      })
      requests.add(upstream); upstream.on('close', () => { requests.delete(upstream) })
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
      req.pipe(upstream)
    })
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => { sockets.delete(socket) }) })
    server.on('upgrade', (req, socket, head) => {
      const world = worlds[selected(req.url)]!
      const upstream = request(new URL(req.url ?? '/', world.baseUrl), { headers: { ...req.headers, cookie: cookies.get(world.baseUrl) ?? '' } })
      requests.add(upstream); upstream.on('close', () => { requests.delete(upstream) })
      upstream.on('error', () => { socket.destroy() })
      upstream.on('upgrade', (response, peer, peerHead) => {
        sockets.add(peer); peer.on('close', () => { sockets.delete(peer) })
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
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
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
    return { worlds, calls, preparations, url: `http://${authority}/?dshRuntime=${personalTargets[0]!.runtimeId}`,
      renewEventStreams: (runtimeId: string): void => {
        for (const [socket, owner] of eventStreams) if (owner === runtimeId) socket.destroy()
      }, close }
  } catch (error) { await close(); throw error }
}
