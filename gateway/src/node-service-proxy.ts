import { forwardingMarks, operationPhase, recordNodeTransport, timeOperation } from './operation-timing.ts'
import { createHash } from 'node:crypto'
/** Forward existing authenticated Gateway operations to their owning computer. */
import { request, STATUS_CODES, type Agent, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { BROWSER_RUNTIME_ASSET_CACHE_CONTROL, isDelegatablePersonalRead, isExplicitScopeRequest, isExplicitSessionRequest, isImmutableRuntimeAssetRequest, isReadyRuntimeInteractive, pinRuntimeRequestPath } from './runtime-request-path.ts'
import type { UserRow } from './auth.ts'
import { RuntimeAssetUnavailableError } from './runtime-asset-admission.ts'
import type { GatewayAccessMonitor, AccessInvalidationSubject } from './access-invalidation.ts'
import type { RuntimeCatalogEntry, RuntimeId, RuntimeNodeId } from './runtime-catalog.ts'
import type { RuntimePlacement, RuntimeSelection } from './runtime-router.ts'
import { parseCookies, SCOPE_COOKIE, SESSION_COOKIE } from './server.ts'
import { RuntimeCatalogError } from './runtime-catalog.ts'
import { nodeUuidSchema } from './node-access.ts'
import { NODE_SERVICE_ASSET_GENERATION_HEADER, NODE_SERVICE_TARGET_HEADER, NodeServiceError, RELEASE_COMBO_DIGEST_HEADER } from './node-service-stream.ts'
import { FORWARDED_PRINCIPAL_HEADER, type PersonalReadAdmission } from './forwarded-principal.ts'
import type { GatewayNodeServices } from './node-service.ts'
import type { NodeServiceConfig } from './node-service.ts'
import { NodeServiceHttpPool, type NodeServiceHttpPoolDiagnostics } from './node-service-http-pool.ts'
import { httpConnectionFields } from './http-connection-fields.ts'
import { isCompressibleContentType, MIN_COMPRESS_BYTES, pipeCompressedResponse, preferredCompression } from './http-compression.ts'

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
  /** Fresh primary-owned authority before forwarding and before releasing the result. */
  approvePersonalRead?(input: { actorId: number; sessionToken: string; runtimeId: RuntimeId;
    nodeId: RuntimeNodeId; target: 'personal' }): Promise<PersonalReadAdmission | null>
}

interface Target { nodeId: RuntimeNodeId; runtimeId?: RuntimeId; projectId?: number; resetCookie?: string;
  /** Authorized environment and verified scope target, when resolution already ran. */
  environment?: RuntimeCatalogEntry; resolvedTarget?: 'personal' | `project:${number}` }
interface Active extends Target { userId: number; abort(): void }

/** A submitted request has no response headers; its remote mutation may already have completed. */
export class NodeServiceResponseUnknownError extends NodeServiceError {
  /** @param cause - transport failure after request submission, before any response headers. */
  constructor(cause: NodeServiceError) {
    super(cause.status, cause.code, cause)
    this.name = 'NodeServiceResponseUnknownError'
  }
}

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

function headers(input: IncomingHttpHeaders, upgrade = false): OutgoingHttpHeaders {
  const omitted = httpConnectionFields(input.connection)
  const result: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(input)) if (!omitted.has(key) && value !== undefined) result[key] = value
  if (upgrade) { result.connection = 'Upgrade'; result.upgrade = 'websocket' }
  return result
}

function responseHeaders(input: IncomingHttpHeaders, resetCookie?: string): OutgoingHttpHeaders {
  const result = headers(input)
  delete result[NODE_SERVICE_ASSET_GENERATION_HEADER]
  delete result[RELEASE_COMBO_DIGEST_HEADER]
  if (resetCookie !== undefined) result['set-cookie'] = [...(input['set-cookie'] ?? []), resetCookie]
  if (typeof result.location === 'string') {
    const location = new URL(result.location, 'http://gateway.invalid')
    if (['127.0.0.1', '[::1]', 'localhost'].includes(location.hostname)) result.location = `${location.pathname}${location.search}${location.hash}`
  }
  return result
}

function immutableFreshness(cacheControl: string, age: string | undefined): number | undefined {
  const directives = cacheControl.toLowerCase().split(',').map(directive => directive.trim())
  if (!directives.includes('public') || !directives.includes('immutable')
    || directives.some(directive => /^(?:private|no-store|no-cache|s-maxage)\b/u.test(directive))) return
  const ages = directives.filter(directive => /^max-age\b/u.test(directive))
  const seconds = ages.length === 1 ? /^max-age\s*=\s*([1-9][0-9]*)$/u.exec(ages[0]!)?.[1] : undefined
  const maxAge = Number(seconds)
  const elapsed = age === undefined ? 0 : /^[0-9]+$/u.test(age) ? Number(age) : NaN
  if (!Number.isSafeInteger(maxAge) || !Number.isSafeInteger(elapsed) || elapsed >= maxAge) return
  return Date.now() + Math.min(maxAge - elapsed, 31_536_000) * 1_000
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

/** Identifier-free cumulative forwarding and delegated-read metrics for the center proxy. */
export interface NodeServiceForwardingDiagnostics {
  readonly httpTotal: number
  readonly upgradeTotal: number
  readonly accessSyncCalls: number
  readonly accessSyncSkipped: number
  readonly preparedReadEligible: number
  readonly preparedReadHit: number
  readonly preparedReadFallback: number
  readonly preparedReadReleaseChecks: number
  readonly preparedReadReleaseSkipped: number
  readonly pool: NodeServiceHttpPoolDiagnostics
}

/** Optional bounded tee for capturing immutable 200 OK remote asset payloads after streaming completes. */
export interface RemoteAssetCapture {
  readonly maxBytes: number
  onComplete(captured: {
    readonly status: number
    readonly contentType: string
    readonly freshUntil: number
    readonly etag?: string
    readonly contentEncoding?: string
    readonly body: Buffer
  }): void
}

/** One immutable response's optional local replacement and bounded capture. */
export interface RemoteAssetDelivery {
  readonly capture?: RemoteAssetCapture
  readonly release?: {
    readonly sha256: string
    /**
     * Recheck admission and deliver the bytes after the destination confirms the digest.
     * @param signal - cancelled when the forwarded operation loses authority or ends.
     */
    serve(signal: AbortSignal): Promise<void>
  }
}

/** One center proxy owner, with independent cancellation for each selected computer/runtime. */
export class GatewayNodeServiceProxy {
  private readonly active = new Set<Active>()
  private readonly work = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private closed = false
  private readonly unsubscribe?: () => void
  private readonly httpPool: NodeServiceHttpPool
  private readonly metrics = {
    httpTotal: 0, upgradeTotal: 0, accessSyncCalls: 0, accessSyncSkipped: 0,
    preparedReadEligible: 0, preparedReadHit: 0, preparedReadFallback: 0,
    preparedReadReleaseChecks: 0,
  }

  /**
   * @param directory - organization-owned placement and current Admin authority.
   * @param services - bounded outbound-node connection owner.
   * @param timeoutMs - response-header deadline, independent of long-lived response streams.
   * @param config - bounded idle HTTP transport retention.
   * @param monitor - existing durable permission-change monitor, when present.
   */
  constructor(private readonly directory: NodeServiceProxyDirectory,
    services: Pick<GatewayNodeServices, 'open' | 'revalidate' | 'released' | 'capacity'>,
    private readonly timeoutMs: number,
    config: NodeServiceConfig,
    private readonly monitor?: GatewayAccessMonitor,
    private readonly forwardIssuer?: (target: Target, user: UserRow, request: ForwardRequest, personalRead?: PersonalReadAdmission) => Promise<string>) {
    if (directory.resolvePlacement !== undefined && directory.resetScopeCookie === undefined) {
      throw new Error('Node service owner routing requires the Gateway scope-cookie formatter')
    }
    this.httpPool = new NodeServiceHttpPool(services, config)
    this.unsubscribe = monitor?.subscribe(subject => { this.invalidate(subject) })
  }

  /**
   * Immediately abort matching forwarded HTTP/WebSocket operations and drain idle transports on node/global invalidation.
   * @param subject - revoked user, project, node, or organization scope (such as explicit logout or permission revocation).
   */
  invalidate(subject: AccessInvalidationSubject): void {
    // Idle node transports carry no user or project credentials; only node- or
    // organization-scoped invalidations need to drain unused byte connections.
    if (subject.userId === undefined && subject.projectId === undefined) {
      void this.httpPool.closeIdle(subject.nodeId)
    }
    for (const operation of this.active) {
      if (subject.nodeId !== undefined && subject.nodeId !== operation.nodeId) continue
      if (subject.userId !== undefined && subject.userId !== operation.userId) continue
      if (subject.projectId !== undefined && subject.projectId !== operation.projectId) continue
      operation.abort()
    }
  }

  private async synchronizeMonitor(reason?: 'runtime-stop'): Promise<void> {
    if (this.monitor === undefined) return
    this.metrics.accessSyncCalls += 1
    await this.monitor.synchronize(reason)
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
      await this.synchronizeMonitor()
      if (this.directory.authorizeAccountNode === undefined) throw new NodeServiceError(503, 'node-service/unavailable')
      const nodeId = node as RuntimeNodeId
      await this.directory.authorizeAccountNode(actor, nodeId)
      return nodeId === this.directory.localNodeId ? null : { nodeId }
    }
    const managedRuntime = /^\/admin\/api\/runtimes\/([^/]+)\/(?:start|stop|restart|retire|personal-directory\/promote)$/.exec(url.pathname)?.[1]
    if (url.pathname.startsWith('/admin/api/') && (runtime !== null || node !== null || managedRuntime !== undefined)) {
      if (actor.role !== 'admin') throw new NodeServiceError(403, 'node-service/invalid-target')
      if (this.closed) throw new NodeServiceError(503, 'node-service/closed')
      const stop = method === 'POST' && managedRuntime !== undefined && url.pathname.endsWith('/stop')
      await this.synchronizeMonitor(stop ? 'runtime-stop' : undefined)
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
    await this.synchronizeMonitor()
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

  private outgoing(req: IncomingMessage, target: Target, agent: Agent, upgrade: boolean, body?: string, assertion?: string,
    releaseDigest?: string) {
    const forwarded = headers(req.headers, upgrade)
    forwarded[NODE_SERVICE_TARGET_HEADER] = target.nodeId
    delete forwarded[NODE_SERVICE_ASSET_GENERATION_HEADER]
    delete forwarded[RELEASE_COMBO_DIGEST_HEADER]
    if (releaseDigest !== undefined) forwarded[RELEASE_COMBO_DIGEST_HEADER] = releaseDigest
    delete forwarded['x-dsh-gateway-principal']
    delete forwarded[FORWARDED_PRINCIPAL_HEADER]
    if (assertion !== undefined) forwarded[FORWARDED_PRINCIPAL_HEADER] = assertion
    const path = target.runtimeId === undefined ? req.url ?? '/' : pinRuntimeRequestPath(req.url ?? '/', target.runtimeId)
    if (body !== undefined) forwarded['content-length'] = Buffer.byteLength(body)
    return request({ hostname: 'node.gateway.invalid', port: 80, method: req.method,
      path, headers: forwarded, agent })
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
   * Forward an immutable resource using this request's fresh governance admission.
   * @param req - strict GET or HEAD module/asset request with an exact Runtime selector.
   * @param res - response owned through the existing bounded node transport.
   * @param actor - current account returned by the asset admission query.
   * @param placement - exact Runtime and computer from the same admission; no cross-request reuse is permitted.
   * @param generation - ready Runtime generation authorized by this request.
   * @param delivery - optional capture and release candidate for this immutable response.
   * @returns true after remote delivery, or false for this computer.
   */
  asset(req: IncomingMessage, res: ServerResponse, actor: UserRow,
    placement: RuntimePlacement & { environment: NonNullable<RuntimePlacement['environment']> },
    generation: number, delivery?: RemoteAssetDelivery): Promise<boolean> {
    if (!isImmutableRuntimeAssetRequest(req.method, req.url ?? '/')) throw new NodeServiceError(400, 'node-service/invalid-target')
    const url = new URL(req.url ?? '/', 'http://gateway'), environment = placement.environment
    if (url.searchParams.getAll('dshRuntime').length !== 1 || url.searchParams.get('dshRuntime') !== environment.id
      || url.searchParams.has('dshNode') && url.searchParams.get('dshNode') !== environment.node.id
      || url.searchParams.has('dshTarget') && url.searchParams.get('dshTarget') !== placement.target
      || req.headers[NODE_SERVICE_TARGET_HEADER] !== undefined && !placement.local) {
      throw new NodeServiceError(409, 'node-service/mismatch')
    }
    if (placement.local) return Promise.resolve(false)
    return this.track(this.forwardSelectedHttp(req, res, {
      nodeId: environment.node.id, runtimeId: environment.id, environment, resolvedTarget: placement.target,
      ...(environment.owner.kind === 'project' ? { projectId: environment.owner.id } : {}),
    }, actor, undefined, { generation, ...delivery }))
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

  private async forwardSelectedHttp(req: IncomingMessage, res: ServerResponse, target: Target, actor: UserRow | number,
    body?: string, asset?: { generation: number } & RemoteAssetDelivery): Promise<boolean> {
    const capture = asset?.capture
    const expectedAssetGeneration = asset === undefined ? undefined : String(asset.generation)
    if (this.closed) throw new NodeServiceError(503, 'node-service/closed')
    await this.directory.assertNode?.(target.nodeId)
    this.metrics.httpTotal += 1
    const owner = new AbortController()
    const signal = AbortSignal.any([owner.signal, this.lifetime.signal])
    const abort = () => { if (!res.writableFinished) owner.abort() }
    const active: Active = { ...target, userId: typeof actor === 'number' ? actor : actor.id, abort: () => { owner.abort() } }
    this.active.add(active)
    req.once('aborted', abort); res.once('close', abort)
    if (req.aborted || res.destroyed || res.writableEnded) owner.abort()
    let dispose = () => {}
    let submitted = false
    let receivedResponse = false
    try {
      signal.throwIfAborted()
      const url = new URL(req.url ?? '/', 'http://gateway')
      const interactive = target.runtimeId !== undefined && (isExplicitSessionRequest(req.method, url.pathname)
        || isReadyRuntimeInteractive(req.method, url.pathname)
        || req.method === 'POST' && (url.pathname === '/api/session.history' || url.pathname === '/api/host.describe')
        || req.method === 'GET' && url.pathname === '/' && url.searchParams.get('dshBootstrap') === '1')
      const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
      const approval = typeof actor !== 'number' && actor.status === 'active' && !actor.mustChangePassword
        && this.forwardIssuer !== undefined && token !== undefined
        && this.directory.approvePersonalRead !== undefined && target.resolvedTarget === 'personal' && target.runtimeId !== undefined
        && isDelegatablePersonalRead(req.method, url, req.headers['x-dsh-expected-principal-id'] === String(actor.id), req.headers.accept)
        && req.headers['x-dsh-prepare-continuation'] === undefined
        && url.searchParams.getAll('dshRuntime').length === 1 && url.searchParams.getAll('dshTarget').length === 1
        && url.searchParams.getAll('dshNode').length <= 1
        ? { actorId: actor.id, sessionToken: token, runtimeId: target.runtimeId, nodeId: target.nodeId, target: 'personal' as const }
        : undefined
      if (approval !== undefined) this.metrics.preparedReadEligible += 1
      const personalRead = approval === undefined ? undefined
        : await timeOperation('entryReadApproval', () => this.directory.approvePersonalRead!(approval)) ?? undefined
      if (approval !== undefined) {
        if (personalRead !== undefined) this.metrics.preparedReadHit += 1
        else this.metrics.preparedReadFallback += 1
      }
      signal.throwIfAborted()
      const lease = await timeOperation('nodeConnection',()=>this.httpPool.acquire(target.nodeId, signal, interactive))
      recordNodeTransport(lease.reused ? 'reused' : 'opened')
      const mark = forwardingMarks()
      mark('leaseAcquired')
      const receivedHeaders=operationPhase('upstream')
      dispose = () => { lease.destroy() }
      signal.throwIfAborted()
      let complete = false
      const assertion = typeof actor === 'number' || this.forwardIssuer === undefined
        ? undefined : await this.forwardIssuer(target, actor, forwardRequestOf(req), personalRead)
      mark('assertionReady')
      signal.throwIfAborted()
      const release = assertion === undefined ? undefined : asset?.release
      const outgoing = this.outgoing(req, target, lease.agent, false, body, assertion, release?.sha256)
      dispose = () => {
        if (complete) lease.release()
        else { outgoing.destroy(); lease.destroy() }
      }
      outgoing.once('socket', () => { mark('socketAssigned') })
      outgoing.once('finish', () => { mark('requestWritten') })
      const cancel = () => { outgoing.destroy(new NodeServiceError(409, 'node-service/cancelled')) }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        await this.track(new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { outgoing.destroy(new NodeServiceError(504, 'node-service/timeout')) }, this.timeoutMs)
          timer.unref()
          outgoing.on('error', error => { clearTimeout(timer); reject(error) })
          outgoing.once('response', response => {
            receivedResponse = true
            clearTimeout(timer)
            response.once('error', reject)
            void (async () => {
              receivedHeaders()
              mark('responseHeaders')
              if (response.headers[NODE_SERVICE_TARGET_HEADER] !== target.nodeId) throw new NodeServiceError(409, 'node-service/mismatch')
              if (approval !== undefined && personalRead !== undefined) {
                this.metrics.preparedReadReleaseChecks += 1
                const current = await timeOperation('entryReadRelease', () => this.directory.approvePersonalRead!(approval))
                if (current === null || current.accessRevision !== personalRead.accessRevision
                  || current.generation !== personalRead.generation || current.port !== personalRead.port
                  || current.startedAt !== personalRead.startedAt || current.launchStamp !== personalRead.launchStamp
                  || Math.min(current.expiresAt, personalRead.expiresAt) <= Date.now()) {
                  throw new NodeServiceError(409, 'node-service/cancelled')
                }
              }
              signal.throwIfAborted()
              const status = response.statusCode ?? 502
              const assetGeneration = response.headers[NODE_SERVICE_ASSET_GENERATION_HEADER]
              if (expectedAssetGeneration !== undefined && assetGeneration !== undefined && assetGeneration !== expectedAssetGeneration) {
                throw new NodeServiceError(409, 'node-service/mismatch')
              }
              const matchedDigest = response.headers[RELEASE_COMBO_DIGEST_HEADER]
              if (asset !== undefined && matchedDigest !== undefined) {
                if (release === undefined || status !== 204 || matchedDigest !== release.sha256
                  || assetGeneration !== expectedAssetGeneration || response.headers['set-cookie'] !== undefined) {
                  throw new NodeServiceError(409, 'node-service/mismatch')
                }
                response.resume()
                await finished(response, { cleanup: true, signal })
                signal.throwIfAborted()
                await release.serve(signal)
                return
              }
              const forwardedHeaders = responseHeaders(response.headers, target.resetCookie)
              if (asset !== undefined) forwardedHeaders['cache-control'] = BROWSER_RUNTIME_ASSET_CACHE_CONTROL
              const declaredLength = typeof response.headers['content-length'] === 'string'
                ? Number(response.headers['content-length']) : undefined
              const rawCacheControl = typeof response.headers['cache-control'] === 'string' ? response.headers['cache-control'] : ''
              const rawVary = Array.isArray(response.headers.vary) ? response.headers.vary.join(',')
                : typeof response.headers.vary === 'string' ? response.headers.vary : ''
              const cacheableVary = rawVary.split(',').map(part => part.trim().toLowerCase()).filter(part => part !== '')
                .every(token => token === 'accept-encoding')
              const freshUntil = capture === undefined ? undefined : immutableFreshness(rawCacheControl, response.headers.age)
              const shouldCapture = capture !== undefined && req.method === 'GET' && status === 200
                && assetGeneration !== undefined && assetGeneration === expectedAssetGeneration
                && target.resetCookie === undefined && response.headers['set-cookie'] === undefined
                && freshUntil !== undefined && cacheableVary
                && (declaredLength === undefined || (Number.isSafeInteger(declaredLength) && declaredLength >= 0 && declaredLength <= capture.maxBytes))
              let capturedChunks: Buffer[] | undefined = shouldCapture ? [] : undefined
              let capturedBytes = 0
              if (capturedChunks !== undefined) {
                response.on('data', (chunk: Buffer | string) => {
                  if (capturedChunks === undefined) return
                  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                  capturedBytes += buf.byteLength
                  if (capturedBytes > capture!.maxBytes) { capturedChunks = undefined; return }
                  capturedChunks.push(buf)
                })
              }
              const contentType = typeof response.headers['content-type'] === 'string'
                ? response.headers['content-type'] : 'application/octet-stream'
              const streamCoding = status === 200 && req.method !== 'HEAD' && req.headers.range === undefined
                && response.headers['content-encoding'] === undefined
                && (declaredLength === undefined || (Number.isSafeInteger(declaredLength) && declaredLength >= MIN_COMPRESS_BYTES))
                && isCompressibleContentType(contentType)
                ? preferredCompression(req.headers['accept-encoding'])
                : undefined
              if (streamCoding !== undefined) {
                await pipeCompressedResponse(response, res, status, forwardedHeaders, streamCoding, declaredLength, signal)
              } else {
                res.writeHead(status, forwardedHeaders)
                await pipeline(response, res, { signal })
              }
              if (capturedChunks !== undefined && freshUntil !== undefined && !signal.aborted) {
                const etag = typeof response.headers.etag === 'string' ? response.headers.etag : undefined
                const contentEncoding = typeof response.headers['content-encoding'] === 'string'
                  ? response.headers['content-encoding'].trim().toLowerCase() : undefined
                capture!.onComplete({
                  status,
                  contentType,
                  freshUntil,
                  ...(etag === undefined ? {} : { etag }),
                  ...(contentEncoding === undefined ? {} : { contentEncoding }),
                  body: Buffer.concat(capturedChunks, capturedBytes),
                })
              }
            })().then(resolve, (error: unknown) => { response.destroy(); reject(error) })
          })
          submitted = true
          if (body === undefined) void pipeline(req, outgoing).catch(reject)
          else outgoing.end(body)
        }))
      } finally { signal.removeEventListener('abort', cancel) }
      complete = true
      return true
    } catch (error) {
      if (error instanceof RuntimeAssetUnavailableError) throw error
      const failure = error instanceof NodeServiceError ? error
        : new NodeServiceError(signal.aborted ? 409 : 503, signal.aborted ? 'node-service/cancelled' : 'node-service/unavailable', error)
      if (submitted && !receivedResponse && (failure.code === 'node-service/timeout' || failure.code === 'node-service/unavailable')) {
        throw new NodeServiceResponseUnknownError(failure)
      }
      throw failure
    } finally {
      req.removeListener('aborted', abort); res.removeListener('close', abort)
      this.active.delete(active); owner.abort(); dispose()
    }
  }

  /**
   * Read cumulative forwarding, delegated-read and pooled-transport metrics without identifiers.
   * @returns Identifier-free counters for administrator performance inspection.
   */
  diagnostics(): NodeServiceForwardingDiagnostics {
    return { ...this.metrics, preparedReadReleaseSkipped: 0, pool: this.httpPool.diagnostics() }
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
    this.metrics.upgradeTotal += 1
    const owner = new AbortController(), abort = () => { owner.abort() }
    const signal = AbortSignal.any([owner.signal, this.lifetime.signal])
    const active: Active = { ...target, userId: actor.id, abort }
    this.active.add(active); socket.once('close', abort)
    if (socket.destroyed) owner.abort()
    let dispose = () => {}
    try {
      signal.throwIfAborted()
      const lease = await this.httpPool.acquire(target.nodeId, signal, true)
      dispose = lease.destroy
      lease.upgrade()
      signal.throwIfAborted()
      const assertion = this.forwardIssuer === undefined ? undefined : await this.forwardIssuer(target, actor, forwardRequestOf(req))
      signal.throwIfAborted()
      const outgoing = this.outgoing(req, target, lease.agent, true, undefined, assertion)
      dispose = () => { outgoing.destroy(); lease.destroy() }
      const cancel = () => { outgoing.destroy(new NodeServiceError(409, 'node-service/cancelled')); lease.destroy() }
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
              void pipeline(socket, upstream, socket).then(resolve, reject)
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
