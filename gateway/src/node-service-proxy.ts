import { operationPhase, timeOperation } from './operation-timing.ts'
import { createHash } from 'node:crypto'
/** Forward existing authenticated Gateway operations to their owning computer. */
import { Agent, request, STATUS_CODES, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isExplicitScopeRequest, isExplicitSessionRequest, pinRuntimeRequestPath } from './runtime-request-path.ts'
import type { UserRow } from './auth.ts'
import type { GatewayAccessMonitor, AccessInvalidationSubject } from './access-invalidation.ts'
import type { RuntimeCatalogEntry, RuntimeId, RuntimeNodeId } from './runtime-catalog.ts'
import type { RuntimePlacement, RuntimeSelection } from './runtime-router.ts'
import { parseCookies, SCOPE_COOKIE, SESSION_COOKIE } from './server.ts'
import { RuntimeCatalogError } from './runtime-catalog.ts'
import { nodeUuidSchema } from './node-access.ts'
import { NODE_SERVICE_TARGET_HEADER, NodeServiceError } from './node-service-stream.ts'
import { FORWARDED_PRINCIPAL_HEADER } from './forwarded-principal.ts'
import type { GatewayNodeServices } from './node-service.ts'
import type { NodeServiceConfig } from './node-service.ts'
import { NodeServiceHttpPool } from './node-service-http-pool.ts'

/** Organization directory and current Admin authority; paths remain owned by the selected Gateway. */
export interface NodeServiceProxyDirectory {
  localNodeId: RuntimeNodeId
  /** Entry-owned topology restriction, applied independently of account authorization. */
  assertNode?(nodeId: RuntimeNodeId): Promise<void>
  resolveForAccount(actor: UserRow, id: string): Promise<RuntimeCatalogEntry>
  /** Exact environment metadata for existing purpose-limited Admin operations. */
  resolveForAdministrator?(actor: UserRow, id: string): Promise<RuntimeCatalogEntry>
  /** When absent, this composition supports only explicit RuntimeId forwarding. */
  resolvePlacement?(actor: UserRow, selection: RuntimeSelection): Promise<RuntimePlacement>
  /** Required with owner routing; the existing Gateway cookie policy formats a repaired legacy selection. */
  resetScopeCookie?: () => string
  authorizeAdministratorNode(actor: UserRow, id: string): Promise<RuntimeNodeId>
  /** Recheck the account's use permission without requiring a personal Runtime on the computer. */
  authorizeAccountNode?(actor: UserRow, id: RuntimeNodeId): Promise<void>
}

interface Target { nodeId: RuntimeNodeId; runtimeId?: RuntimeId; projectId?: number; resetCookie?: string;
  /** Authorized environment and verified scope target, when resolution already ran. */
  environment?: RuntimeCatalogEntry; resolvedTarget?: 'personal' | `project:${number}` }
interface Active extends Target { userId: number; abort(): void }

/** The request binding an issuer signs into a forwarded assertion. */
interface ForwardRequest { method: string; path: string; sessionHash: string }

/** Bind the assertion to this exact request line and the session cookie being forwarded. */
function forwardRequestOf(req: IncomingMessage): ForwardRequest {
  const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE) ?? ''
  return {
    method: req.method ?? 'GET',
    path: new URL(req.url ?? '/', 'http://gateway').pathname,
    sessionHash: createHash('sha256').update(token).digest('hex'),
  }
}

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function headers(input: IncomingHttpHeaders, upgrade = false): OutgoingHttpHeaders {
  const omitted = new Set([...HOP_HEADERS, ...(input.connection ?? '').toLowerCase().split(',').map(value => value.trim())])
  const result: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(input)) if (!omitted.has(key) && value !== undefined) result[key] = value
  if (upgrade) { result.connection = 'Upgrade'; result.upgrade = 'websocket' }
  return result
}

function responseHeaders(input: IncomingHttpHeaders, resetCookie?: string): OutgoingHttpHeaders {
  const result = headers(input)
  if (resetCookie !== undefined) result['set-cookie'] = [...(input['set-cookie'] ?? []), resetCookie]
  if (typeof result.location === 'string') {
    const location = new URL(result.location, 'http://gateway.invalid')
    if (['127.0.0.1', '[::1]', 'localhost'].includes(location.hostname)) result.location = `${location.pathname}${location.search}${location.hash}`
  }
  return result
}

function rawResponse(status: number, input: IncomingHttpHeaders, upgrade: boolean, resetCookie?: string): string {
  const result = upgrade ? { ...headers(input, true) } : responseHeaders(input, resetCookie)
  if (upgrade && resetCookie !== undefined) result['set-cookie'] = [...(input['set-cookie'] ?? []), resetCookie]
  if (!upgrade) { delete result['content-length']; result.connection = 'close' }
  const lines = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Response'}`]
  for (const [key, value] of Object.entries(result)) {
    for (const entry of Array.isArray(value) ? value : [value]) if (entry !== undefined) lines.push(`${key}: ${String(entry)}`)
  }
  return `${lines.join('\r\n')}\r\n\r\n`
}

/** One center proxy owner, with independent cancellation for each selected computer/runtime. */
export class GatewayNodeServiceProxy {
  private readonly active = new Set<Active>()
  private readonly work = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private closed = false
  private readonly unsubscribe?: () => void
  private readonly httpPool: NodeServiceHttpPool

  /**
   * @param directory - organization-owned placement and current Admin authority.
   * @param services - bounded outbound-node connection owner.
   * @param timeoutMs - response-header deadline, independent of long-lived response streams.
   * @param config - bounded idle HTTP transport retention.
   * @param monitor - existing durable permission-change monitor, when present.
   */
  constructor(private readonly directory: NodeServiceProxyDirectory,
    private readonly services: Pick<GatewayNodeServices, 'open' | 'revalidate' | 'released' | 'capacity'>,
    private readonly timeoutMs: number,
    config: NodeServiceConfig,
    private readonly monitor?: GatewayAccessMonitor,
    private readonly forwardIssuer?: (target: Target, user: UserRow, request: ForwardRequest) => Promise<string>) {
    if (directory.resolvePlacement !== undefined && directory.resetScopeCookie === undefined) {
      throw new Error('Node service owner routing requires the Gateway scope-cookie formatter')
    }
    this.httpPool = new NodeServiceHttpPool(services, config)
    this.unsubscribe = monitor?.subscribe(subject => { this.invalidate(subject) })
  }

  private invalidate(subject: AccessInvalidationSubject): void {
    void this.httpPool.closeIdle(subject.nodeId)
    for (const operation of this.active) {
      if (subject.nodeId !== undefined && subject.nodeId !== operation.nodeId) continue
      if (subject.userId !== undefined && subject.userId !== operation.userId) continue
      if (subject.projectId !== undefined && subject.projectId !== operation.projectId) continue
      operation.abort()
    }
  }

  private async target(actor: UserRow, url: URL, cookie: string | undefined, method?: string, onLocal?: (placement: RuntimePlacement) => void): Promise<Target | null> {
    const runtime = url.searchParams.get('dshRuntime'), node = url.searchParams.get('dshNode')
    // Account-wide metadata remains available before the user selects one of several personal Runtimes.
    if (/^\/account\/api\/(?:users|preferences|push-devices(?:\/[^/]+)?|workbench\/catalog|invitations(?:\/[^/]+\/accept|\/count)?)$/u.test(url.pathname)
      || url.pathname === '/account/api/projects' && method === 'GET') return null
    const nodeMetadata = method === 'GET' && (url.pathname === '/account/api/project-metadata' || url.pathname === '/account/api/node-document-overview')
    if ((url.pathname.startsWith('/api/documents') || url.pathname === '/account/api/projects' && method === 'POST' || nodeMetadata) && runtime === null) {
      if (node === null) return null
      if (!nodeUuidSchema.safeParse(node).success) throw new NodeServiceError(400, 'node-service/invalid-target')
      if (this.closed) throw new NodeServiceError(503, 'node-service/closed')
      await this.monitor?.synchronize()
      if (this.directory.authorizeAccountNode === undefined) throw new NodeServiceError(503, 'node-service/unavailable')
      const nodeId = node as RuntimeNodeId
      await this.directory.authorizeAccountNode(actor, nodeId)
      return nodeId === this.directory.localNodeId ? null : { nodeId }
    }
    const managedRuntime = /^\/admin\/api\/runtimes\/([^/]+)\/(?:start|stop|restart|retire|personal-directory\/promote)$/.exec(url.pathname)?.[1]
    if (url.pathname.startsWith('/admin/api/') && (runtime !== null || node !== null || managedRuntime !== undefined)) {
      if (actor.role !== 'admin') throw new NodeServiceError(403, 'node-service/invalid-target')
      if (this.closed) throw new NodeServiceError(503, 'node-service/closed')
      await this.monitor?.synchronize()
      if (runtime !== null || managedRuntime !== undefined) {
        if (runtime !== null && managedRuntime !== undefined && runtime !== managedRuntime) throw new NodeServiceError(400, 'node-service/invalid-target')
        if (this.directory.resolveForAdministrator === undefined) throw new NodeServiceError(503, 'node-service/unavailable')
        const environment = await this.directory.resolveForAdministrator(actor, managedRuntime ?? runtime!)
        if (node !== null && node !== environment.node.id) throw new NodeServiceError(400, 'node-service/invalid-target')
        if (environment.node.id === this.directory.localNodeId) return null
        return { nodeId: environment.node.id, runtimeId: environment.id }
      }
      if (!nodeUuidSchema.safeParse(node).success) throw new NodeServiceError(400, 'node-service/invalid-target')
      const authorized = await this.directory.authorizeAdministratorNode(actor, node!)
      return authorized === this.directory.localNodeId ? null : { nodeId: authorized }
    }
    const scopeChange = url.pathname === '/account/api/scope' || url.pathname === '/account/runtime/start'
    const runtimePath = url.pathname === '/' || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/plugins/') || url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg'
      || /^\/admin\/projects\/[1-9][0-9]*\/settings$/u.test(url.pathname) || url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/account/api/') || scopeChange
    if (runtime === null && node === null && (!runtimePath || scopeChange || this.directory.resolvePlacement === undefined)) return null
    if (this.closed) throw new NodeServiceError(503, 'node-service/closed')
    await this.monitor?.synchronize()
    if (!runtimePath
      && !url.pathname.startsWith('/admin/api/')) throw new NodeServiceError(400, 'node-service/invalid-target')
    if (runtime !== null || node === null) {
      const projectId = /^\/account\/api\/projects\/([1-9][0-9]*)(?:\/|$)/u.exec(url.pathname)?.[1]
      const projectTarget = projectId === undefined ? undefined : `project:${projectId}`
      const requestedTarget = url.searchParams.get('dshTarget')
      if (projectTarget !== undefined && requestedTarget !== null && requestedTarget !== projectTarget) {
        throw new RuntimeCatalogError(400, 'runtime-catalog/target-mismatch')
      }
      const placement = this.directory.resolvePlacement === undefined ? undefined
        : await this.directory.resolvePlacement(actor, { runtimeId: runtime, target: projectTarget ?? requestedTarget,
          scopeCookie: projectTarget === undefined ? parseCookies(cookie).get(SCOPE_COOKIE) : undefined })
      const environment = placement?.environment ?? (runtime === null ? undefined : await this.directory.resolveForAccount(actor, runtime))
      if (environment === undefined) throw new RuntimeCatalogError(503, 'runtime-catalog/unavailable')
      if (this.closed) throw new NodeServiceError(503, 'node-service/closed')
      if (node !== null && node !== environment.node.id) throw new NodeServiceError(400, 'node-service/invalid-target')
      const target = projectTarget ?? requestedTarget
      const expected = environment.owner.kind === 'personal' ? 'personal' : `project:${String(environment.owner.id)}`
      if (target !== null && target !== expected) throw new RuntimeCatalogError(400, 'runtime-catalog/target-mismatch')
      if (environment.node.id === this.directory.localNodeId) {
        if (placement?.local) onLocal?.(placement)
        return null
      }
      return { nodeId: environment.node.id, runtimeId: environment.id, environment,
        resolvedTarget: environment.owner.kind === 'personal' ? 'personal' : `project:${environment.owner.id}`,
        ...(placement?.resetScope === true ? { resetCookie: this.directory.resetScopeCookie!() } : {}),
        ...(environment.owner.kind === 'project' ? { projectId: environment.owner.id } : {}) }
    }
    throw new NodeServiceError(403, 'node-service/invalid-target')
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.work.add(operation)
    void operation.then(() => { this.work.delete(operation) }, () => { this.work.delete(operation) })
    return operation
  }

  private outgoing(req: IncomingMessage, target: Target, stream: Duplex | Agent, upgrade: boolean, body?: string, assertion?: string) {
    const agent = stream instanceof Agent ? stream : new Agent({ keepAlive: false, maxSockets: 1 })
    if (!(stream instanceof Agent)) agent.createConnection = () => stream
    const forwarded = headers(req.headers, upgrade)
    forwarded[NODE_SERVICE_TARGET_HEADER] = target.nodeId
    delete forwarded['x-dsh-gateway-principal']
    delete forwarded[FORWARDED_PRINCIPAL_HEADER]
    if (assertion !== undefined) forwarded[FORWARDED_PRINCIPAL_HEADER] = assertion
    const path = target.runtimeId === undefined ? req.url ?? '/' : pinRuntimeRequestPath(req.url ?? '/', target.runtimeId)
    if (body !== undefined) forwarded['content-length'] = Buffer.byteLength(body)
    const outgoing = request({ hostname: 'node.gateway.invalid', port: 80, method: req.method,
      path, headers: forwarded, agent })
    return { outgoing, dispose: () => {
      outgoing.destroy()
      if (!(stream instanceof Agent)) { agent.destroy(); stream.destroy() }
    } }
  }

  /**
   * Forward a selected remote API request; local and unselected requests remain in the existing handler.
   * @param req - authenticated original request with its existing cookie and explicit selectors.
   * @param res - browser response; partial failures close the stream instead of reporting success.
   * @param actor - current authenticated account, also rechecked by the destination Gateway.
   * @param parsed - optional bounded body already consumed by the scope parser, with its authorized exact RuntimeId; omission streams the original request.
   * @param onLocal - shares this request's already authorized local selection with its destination handler.
   * @returns true after a remote response completes, or false for a local request.
   */
  http(req: IncomingMessage, res: ServerResponse, actor: UserRow, parsed?: { body: string; runtimeId: RuntimeId },
    onLocal?: (placement: RuntimePlacement) => void): Promise<boolean> {
    return this.track(this.forwardHttp(req, res, actor, parsed, onLocal))
  }

  /**
   * Stream one public provider delivery to metadata-confirmed placement; provider authentication remains node-owned.
   * @param req - original POST whose exact public webhook path is retained.
   * @param res - provider-facing response.
   * @param nodeId - endpoint placement resolved from shared metadata, never a request selector.
   * @returns false for this computer, or true after the owning Gateway's response completes.
   */
  webhook(req: IncomingMessage, res: ServerResponse, nodeId: RuntimeNodeId): Promise<boolean> {
    const path = new URL(req.url ?? '/', 'http://gateway').pathname
    if (req.method !== 'POST' || !/^\/webhook\/[1-9][0-9]*$/u.test(path)) throw new NodeServiceError(400, 'node-service/invalid-target')
    if (nodeId === this.directory.localNodeId) return Promise.resolve(false)
    return this.track(this.forwardSelectedHttp(req, res, { nodeId }, 0))
  }

  private async forwardHttp(req: IncomingMessage, res: ServerResponse, actor: UserRow, parsed?: { body: string; runtimeId: RuntimeId },
    onLocal?: (placement: RuntimePlacement) => void): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://gateway')
    if (parsed !== undefined) url.searchParams.set('dshRuntime', parsed.runtimeId)
    const target = await this.target(actor, url, req.headers.cookie, req.method,onLocal)
    if (target === null) return false
    // A managed request has reached its selected Gateway. A newer placement requires a fresh request from the entry.
    if (req.headers[NODE_SERVICE_TARGET_HEADER] !== undefined
      && (isExplicitSessionRequest(req.method, url.pathname) || isExplicitScopeRequest(req.method, url))) {
      throw new NodeServiceError(409, 'node-service/mismatch')
    }
    return this.forwardSelectedHttp(req,res,target,actor,parsed?.body)
  }

  private async forwardSelectedHttp(req: IncomingMessage, res: ServerResponse, target: Target, actor: UserRow | number, body?: string): Promise<boolean> {
    if (this.closed) throw new NodeServiceError(503, 'node-service/closed')
    await this.directory.assertNode?.(target.nodeId)
    const owner = new AbortController()
    const signal = AbortSignal.any([owner.signal, this.lifetime.signal])
    const abort = () => { if (!res.writableFinished) owner.abort() }
    const active: Active = { ...target, userId: typeof actor === 'number' ? actor : actor.id, abort: () => { owner.abort() } }
    this.active.add(active)
    req.once('aborted', abort); res.once('close', abort)
    if (req.aborted || res.destroyed || res.writableEnded) owner.abort()
    let dispose = () => {}
    try {
      signal.throwIfAborted()
      const lease = await timeOperation('nodeConnection',()=>this.httpPool.acquire(target.nodeId, signal))
      const receivedHeaders=operationPhase('upstream')
      dispose = () => { lease.destroy() }
      signal.throwIfAborted()
      let complete = false
      const assertion = typeof actor === 'number' || this.forwardIssuer === undefined
        ? undefined : await this.forwardIssuer(target, actor, forwardRequestOf(req))
      const operation = this.outgoing(req, target, lease.agent, false, body, assertion)
      dispose = () => {
        if (complete) lease.release()
        else { operation.dispose(); lease.destroy() }
      }
      const { outgoing } = operation
      const cancel = () => { outgoing.destroy(new NodeServiceError(409, 'node-service/cancelled')) }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        await this.track(new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { outgoing.destroy(new NodeServiceError(504, 'node-service/timeout')) }, this.timeoutMs)
          timer.unref()
          outgoing.on('error', error => { clearTimeout(timer); reject(error) })
          outgoing.once('response', response => {
            clearTimeout(timer)
            try {
              receivedHeaders()
              if (response.headers[NODE_SERVICE_TARGET_HEADER] !== target.nodeId) throw new NodeServiceError(409, 'node-service/mismatch')
              signal.throwIfAborted()
              res.writeHead(response.statusCode ?? 502, responseHeaders(response.headers, target.resetCookie))
              void pipeline(response, res).then(resolve, reject)
            } catch (error) { response.destroy(); reject(error) }
          })
          if (body === undefined) void pipeline(req, outgoing).catch(reject)
          else outgoing.end(body)
        }))
      } finally { signal.removeEventListener('abort', cancel) }
      complete = true
      return true
    } catch (error) {
      if (error instanceof NodeServiceError) throw error
      throw new NodeServiceError(signal.aborted ? 409 : 503, signal.aborted ? 'node-service/cancelled' : 'node-service/unavailable', error)
    } finally {
      req.removeListener('aborted', abort); res.removeListener('close', abort)
      this.active.delete(active); owner.abort(); dispose()
    }
  }

  /**
   * Close unused HTTP transports before the node's final detachment admission check.
   * @param nodeId - reviewed computer; active requests and browser WebSockets remain owned.
   * @returns after its idle transports have closed.
   */
  closeIdle(nodeId: RuntimeNodeId): Promise<void> { return this.httpPool.closeIdle(nodeId) }

  /**
   * Forward a remote browser WebSocket through the destination Gateway's existing upgrade handler.
   * @param req - browser-authenticated request; the destination repeats its normal authorization.
   * @param socket - browser connection.
   * @param head - browser parser's upgrade prefix.
   * @param actor - authenticated browser account.
   * @returns true after a remote connection settles, or false for local dispatch.
   */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, actor: UserRow): Promise<boolean> {
    return this.track(this.forwardUpgrade(req, socket, head, actor))
  }

  private async forwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, actor: UserRow): Promise<boolean> {
    const target = await this.target(actor, new URL(req.url ?? '/', 'http://gateway'), req.headers.cookie, req.method)
    if (target === null) return false
    await this.directory.assertNode?.(target.nodeId)
    const owner = new AbortController(), abort = () => { owner.abort() }
    const signal = AbortSignal.any([owner.signal, this.lifetime.signal])
    const active: Active = { ...target, userId: actor.id, abort }
    this.active.add(active); socket.once('close', abort)
    if (socket.destroyed) owner.abort()
    let dispose = () => {}
    try {
      signal.throwIfAborted()
      const stream = await this.services.open(target.nodeId, signal)
      dispose = () => { stream.destroy() }
      signal.throwIfAborted()
      const operation = this.outgoing(req, target, stream, true, undefined,
        this.forwardIssuer === undefined ? undefined : await this.forwardIssuer(target, actor, forwardRequestOf(req)))
      dispose = operation.dispose
      const { outgoing } = operation
      const cancel = () => { outgoing.destroy(new NodeServiceError(409, 'node-service/cancelled')) }
      signal.addEventListener('abort', cancel, { once: true })
      let upgraded = false
      try {
        await this.track(new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { outgoing.destroy(new NodeServiceError(504, 'node-service/timeout')) }, this.timeoutMs)
          timer.unref()
          outgoing.on('error', error => { clearTimeout(timer); reject(error) })
          outgoing.once('response', response => {
            clearTimeout(timer)
            try {
              if (response.headers[NODE_SERVICE_TARGET_HEADER] !== target.nodeId) throw new NodeServiceError(409, 'node-service/mismatch')
              signal.throwIfAborted()
              upgraded = true
              socket.write(rawResponse(response.statusCode ?? 502, response.headers, false, target.resetCookie))
              void pipeline(response, socket).then(resolve, reject)
            } catch (error) { response.destroy(); reject(error) }
          })
          outgoing.once('upgrade', (response, upstream, prefix) => {
            clearTimeout(timer)
            try {
              if (response.headers[NODE_SERVICE_TARGET_HEADER] !== target.nodeId) throw new NodeServiceError(409, 'node-service/mismatch')
              signal.throwIfAborted()
              upgraded = true
              socket.write(rawResponse(101, response.headers, true, target.resetCookie))
              if (prefix.length > 0) socket.write(prefix)
              if (head.length > 0) upstream.write(head)
              void Promise.all([pipeline(socket, upstream), pipeline(upstream, socket)]).then(() => { resolve() }, reject)
            } catch (error) { upstream.destroy(); reject(error) }
          })
          outgoing.end()
        }))
      } catch (error) {
        if (!upgraded) throw error
        socket.destroy()
      } finally { signal.removeEventListener('abort', cancel) }
      return true
    } catch (error) {
      if (error instanceof NodeServiceError) throw error
      throw new NodeServiceError(signal.aborted ? 409 : 503, signal.aborted ? 'node-service/cancelled' : 'node-service/unavailable', error)
    } finally {
      socket.removeListener('close', abort)
      this.active.delete(active); owner.abort(); dispose()
    }
  }

  /**
   * Stop new forwarding and await owned HTTP/WebSocket operations before releasing node transports.
   * @returns after permission subscriptions and forwarding work are disposed.
   */
  async close(): Promise<void> {
    this.closed = true; this.unsubscribe?.(); this.lifetime.abort()
    for (const operation of this.active) operation.abort()
    await Promise.allSettled([...this.work, this.httpPool.close()])
  }
}
