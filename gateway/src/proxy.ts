import { timeOperation } from './operation-timing.ts'
import { ServerResponse, type IncomingMessage } from 'node:http'
import { dirname } from 'node:path'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import * as httpProxy from 'http-proxy-3'
import { writeRuntimeGrantsFile } from './apply-grants.ts'
import {
  ensureModelGovernanceForProject,
  ensureModelGovernanceForUser,
  writeModelGovernanceFile,
  writeProjectModelGovernanceFile,
} from './apply-model-governance.ts'
import type { UserRow, StreamSessionQualification } from './auth.ts'
import type { GatewayConfig } from './config.ts'
import type { EffectiveGrant } from './projects.ts'
import { gateCopy, gateLanguage, stoppedPage, waitingPage, type GatePageLanguage } from './html.ts'
import { RuntimeLeaseUnavailableError, RuntimeStartBlockedError, runtimeTargetOf, type ProjectRuntime, type RuntimeTarget } from './instances.ts'
import { PRINCIPAL_HEADER, type GatewayPrincipalSigner, type PrincipalScope } from './principal.ts'
import { isExplicitSessionRequest, runtimeRequestPath } from './runtime-request-path.ts'
import { runtimeDirectoryGrants } from './runtime-directory-grants.ts'
import { StreamPrincipalLeases } from './stream-principal-leases.ts'
import { NODE_SERVICE_TARGET_HEADER } from './node-service-stream.ts'
import { ComputerAccessError } from './computer-access.ts'
import { parseCookies, SESSION_COOKIE, type GatewayAccessInvalidation, type GatewayDeps, type GatewayRequestContext, type ProxyHandler, type UpgradeHandler } from './server.ts'

function wantsHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('text/html')
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === '::1') return true
  return isIP(normalized) === 4 && normalized.split('.', 1)[0] === '127'
}

/** Keep an upstream runtime redirect on the public Gateway origin. */
function publicLocation(value: string): string {
  let target: URL
  try {
    target = new URL(value, 'http://gateway.internal')
  } catch {
    return value
  }
  if (!isLoopbackHostname(target.hostname)) return value
  return `${target.pathname}${target.search}${target.hash}` || '/'
}

/**
 * Directory grants projected into a project runtime's policy file. A standard
 * project only gets its own workspace at rw; the steward space additionally
 * reads the deployment tree — the releases collection under managed layouts,
 * the repository root otherwise — plus operator-declared roots such as a log
 * directory, because the channel exists to inspect what it maintains.
 * @param cfg - resolved gateway configuration.
 * @param project - the runtime's project owner facts.
 * @returns the grant rows written to `directory-grants.json`.
 */
export function projectRuntimeGrants(cfg: GatewayConfig, project: ProjectRuntime): EffectiveGrant[] {
  const grants: EffectiveGrant[] = [{ path: project.path, mode: 'rw', label: project.name }]
  if (project.steward === true) {
    const deploymentRoot = cfg.releaseRoot === undefined ? cfg.dshRepoRoot : dirname(cfg.releaseRoot)
    grants.push({ path: deploymentRoot, mode: 'ro', label: deploymentRoot })
    for (const path of cfg.steward.readRoots) grants.push({ path, mode: 'ro', label: path })
  }
  return grants
}

/** Keep high-volume resumable data-plane requests out of one-row-per-request audit logs. */
function isDocumentUploadDataPath(method: string | undefined, pathname: string): boolean {
  return /^\/api\/documents\/uploads\/[^/]+\/chunks\/[0-9]+$/u.test(pathname)
    || (method === 'GET' && /^\/api\/documents\/uploads\/[^/]+$/u.test(pathname))
    || /^\/api\/documents\/transfer\/uploads\/[^/]+\/chunks\/[0-9]+$/u.test(pathname)
    || (method === 'GET' && /^\/api\/documents\/transfer\/uploads\/[^/]+$/u.test(pathname))
}

/** Remove browser and proxy credentials before a request enters a runtime. */
function scrubRuntimeHeaders(req: IncomingMessage): void {
  for (const name of [
    'authorization',
    'cookie',
    'proxy-authorization',
    'proxy-authenticate',
    'set-cookie',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-real-ip',
  ]) delete req.headers[name]
}

/** Response media types whose streams may legitimately idle past the upstream timeout. */
const STREAMING_MEDIA_TYPES = new Set(['text/event-stream', 'application/x-ndjson'])

export function createProxyHandlers(
  deps: GatewayDeps,
  principalSigner?: GatewayPrincipalSigner,
): { proxy: ProxyHandler; upgrade: UpgradeHandler; invalidateAccess: GatewayAccessInvalidation; streamPrincipals?: StreamPrincipalLeases; close(): void } {
  const { cfg, instances, audit, projects } = deps
  const server = httpProxy.createProxyServer({
    xfwd: true,
    // Bounds upstream connect and time to first byte only: STREAMING_MEDIA_TYPES
    // disarm it once headers arrive. The http-proxy `timeout` option is not set;
    // it would put the same idle bound on the client-facing socket, where it
    // persists on keep-alive connections and kills any stream that pauses.
    proxyTimeout: cfg.upstreamTimeoutMs,
  })
  // http-proxy-3 emits a server-level 'error' for failures outside the
  // per-request callback — notably any 'error' on the client socket of an
  // upgraded WebSocket — and rethrows it when the application adds no
  // listener, taking the whole gateway down. Absorb it here: the per-request
  // callback already answers what it can; this listener owns the rest.
  server.on('error', (error: unknown, req: IncomingMessage | undefined, resOrSocket: ServerResponse | Duplex | undefined) => {
    const code = (error as { code?: unknown })?.code
    console.error(`[gateway] proxy upstream error${typeof code === 'string' ? ` (${code})` : ''}: ${req?.method ?? ''} ${req?.url ?? ''}`)
    if (resOrSocket === undefined || resOrSocket === null) return
    if (resOrSocket instanceof ServerResponse) {
      if (!resOrSocket.destroyed && !resOrSocket.headersSent) {
        resOrSocket.writeHead(502, { 'content-type': 'application/json' })
        resOrSocket.end(JSON.stringify({ error: { code: 'INSTANCE_UNREACHABLE', message: 'The runtime is unavailable. Retry shortly.' } }))
      } else if (!resOrSocket.destroyed && !resOrSocket.writableEnded) resOrSocket.destroy()
      return
    }
    resOrSocket.destroy()
  })
  const active = new Set<{ context: GatewayRequestContext; cancel(): void }>()
  const qualifyStream = async (token: string, context: GatewayRequestContext): Promise<(StreamSessionQualification & { scope: PrincipalScope }) | null> => {
    const current = await deps.auth.qualifyForStream(token)
    if (current === null || current.user.id !== context.user.id || current.user.mustChangePassword
      || current.user.homePath !== context.user.homePath) return null
    if (context.scope.kind === 'personal') return { ...current, scope: { kind: 'personal' } }
    const project = await deps.collaboration?.projectForUser(context.scope.projectId, current.user.id)
    if (project === undefined || project === null || 'username' in context.runtime || project.path !== context.runtime.path) return null
    return { ...current, scope: {
      kind: 'project', projectId: project.projectId, projectName: project.name, mode: project.mode,
      canManage: current.user.role === 'admin' || project.administrator || project.canManage,
      ...(project.kind === 'steward' ? { steward: true } : {}),
      ...(project.uiThemePolicy === undefined ? {} : { uiThemePolicy: project.uiThemePolicy }),
    } }
  }
  const streamPrincipals = principalSigner === undefined || !cfg.streamPrincipalRenewal.enabled ? undefined : new StreamPrincipalLeases({
    signer: principalSigner,
    maxBatchSize: cfg.streamPrincipalRenewal.maxBatchSize,
    synchronize: async () => {
      if (deps.accessMonitor === undefined) throw new Error('event connection access monitor is unavailable')
      await deps.accessMonitor.synchronize()
      if (!deps.accessMonitor.available) throw new Error('event connection access monitor is unavailable')
    },
    qualify: qualifyStream,
  })
  server.on('proxyReqWs', upstream => {
    if (deps.nodeServiceIdentity === undefined) return
    upstream.prependOnceListener('upgrade', (response: IncomingMessage) => {
      response.headers[NODE_SERVICE_TARGET_HEADER] = deps.nodeServiceIdentity!.nodeId
    })
  })
  const invalidateAccess: GatewayAccessInvalidation = (subject) => {
    if (subject.nodeId !== undefined && deps.nodeServiceIdentity !== undefined && subject.nodeId !== deps.nodeServiceIdentity.nodeId) return
    for (const operation of [...active]) {
      const { user, scope } = operation.context
      if (subject.userId !== undefined && subject.userId !== user.id) continue
      if (subject.projectId !== undefined && (scope.kind !== 'project' || scope.projectId !== subject.projectId)) continue
      operation.cancel()
    }
  }
  const unsubscribeAccess = deps.accessMonitor?.subscribe(async (subject) => {
    if (subject.nodeId !== undefined && deps.nodeServiceIdentity !== undefined && subject.nodeId !== deps.nodeServiceIdentity.nodeId) return
    invalidateAccess(subject)
    if (subject.restartRuntime !== true) return
    const stopOwned = async (target: RuntimeTarget): Promise<void> => {
      if (instances.targetsForOwner !== undefined) {
        for (const runtime of await instances.targetsForOwner(target)) await instances.stop(runtime, 'access-change')
        return
      }
      if (instances.owns !== undefined && !await instances.owns(target)) return
      await instances.stop(target, 'access-change')
    }
    if (subject.userId !== undefined) await stopOwned({ kind: 'user', id: subject.userId })
    if (subject.projectId !== undefined) await stopOwned({ kind: 'project', id: subject.projectId })
  })

  async function revalidate(token: string | undefined, context: GatewayRequestContext): Promise<boolean> {
    await deps.accessMonitor?.synchronize()
    if (token === undefined) return false
    const user = deps.revalidateOnComputer ? await deps.revalidateOnComputer(token) : await deps.auth.validate(token)
    if (user === null || user.id !== context.user.id || user.mustChangePassword) return false
    if (deps.revalidateOnComputer === undefined && deps.computerAccess !== undefined) {
      try { await deps.computerAccess.authorize(user.id) }
      catch (error) { if (error instanceof ComputerAccessError) return false; throw error }
    }
    if (context.scope.kind === 'project') {
      const project = await deps.collaboration?.projectForUser(context.scope.projectId, user.id)
      if (project === undefined || project === null || 'username' in context.runtime || project.path !== context.runtime.path) return false
      context.scope = {
        ...context.scope, mode: project.mode,
        canManage: project.canManage,
      }
    } else if (user.homePath !== context.user.homePath || user.role !== context.user.role) {
      return false
    }
    context.user = user
    // Include changes committed while the account/project reads were in flight.
    await deps.accessMonitor?.synchronize()
    return true
  }
  server.on('proxyRes', (proxyResponse, req, res) => {
    // Runtime plugins cannot replace the Gateway's authenticated response identity.
    delete proxyResponse.headers['x-dsh-runtime-id']
    const location = proxyResponse.headers.location
    if (typeof location === 'string') {
      const rewritten = publicLocation(location)
      if (rewritten !== location) proxyResponse.headers.location = rewritten
    }
    const mediaType = proxyResponse.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== undefined && STREAMING_MEDIA_TYPES.has(mediaType)) {
      proxyResponse.socket.setTimeout(0)
    }
    // http-proxy-3 pipes proxyRes without an error listener, so an upstream
    // reset mid-body (e.g. the runtime dying, or our own proxyReq.destroy on
    // client disconnect) would escape as an uncaught stream error.
    proxyResponse.once('error', (error) => {
      const code = (error as { code?: unknown })?.code
      console.error(`[gateway] proxy response stream error${typeof code === 'string' ? ` (${code})` : ''}: ${req.method} ${req.url}`)
      if (!res.destroyed && !res.writableEnded) res.destroy()
    })
  })

  // Grants handoff is intrinsic to starting an instance: the manager calls this
  // just before every spawn, so the child always reads the current grants.
  instances.beforeStart = async (runtime): Promise<void> => {
    if (runtime.user !== undefined) {
      writeRuntimeGrantsFile(runtime.dshHome, await runtimeDirectoryGrants(runtime.user, projects), cfg.usersRoot)
      if (deps.governance !== undefined) await writeModelGovernanceFile(cfg, deps.governance, runtime.user)
    } else {
      if (runtime.project === undefined) throw new Error(`runtime ${runtime.runtimeKey} has no owner facts`)
      writeRuntimeGrantsFile(runtime.dshHome, projectRuntimeGrants(cfg, runtime.project), cfg.projectRuntimesRoot)
      if (deps.governance !== undefined) {
        await writeProjectModelGovernanceFile(cfg, deps.governance, runtime.project)
      }
    }
    if (deps.pluginState !== undefined) {
      // Desired state is newer than what this instance last applied when the
      // manager's write-back already carried it: only pending revisions write.
      const pending = await deps.pluginState.projection(runtime.target)
      if (pending !== null && pending !== 'current') {
        await deps.pluginState.project(runtime.dshHome, pending.state)
        await deps.pluginState.markApplied(runtime.target, pending.revision)
      }
    }
  }
  instances.beforeUse = async (runtime): Promise<void> => {
    if (deps.governance === undefined) return
    if ('username' in runtime) {
      await ensureModelGovernanceForUser(cfg, deps.governance, runtime)
      return
    }
    await ensureModelGovernanceForProject(cfg, deps.governance, runtime)
  }

  const targetFor = (context: GatewayRequestContext): RuntimeTarget => runtimeTargetOf(context.runtime)

  function refuseStopped(req: IncomingMessage, res: ServerResponse, target: RuntimeTarget, lang: GatePageLanguage): void {
    res.setHeader('cache-control', 'no-store')
    if (wantsHtml(req)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(stoppedPage(target, lang))
    } else {
      res.writeHead(409, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'INSTANCE_STOPPED', message: `${gateCopy(lang)('stoppedHeading')} ${gateCopy(lang)('stoppedBody')}` } }))
    }
  }

  async function ensureReady(
    req: IncomingMessage,
    res: ServerResponse | null,
    context: GatewayRequestContext,
    lang: GatePageLanguage,
  ): Promise<{ port: number; generation: number; target: RuntimeTarget } | null> {
    const target = targetFor(context)
    const selection = new URL(req.url ?? '/', 'http://gateway')
    if (isExplicitSessionRequest(req.method, selection.pathname)) {
      const expectedScope = context.scope.kind === 'personal' ? 'personal' : `project:${context.scope.projectId}`
      const nodes = selection.searchParams.getAll('dshNode')
      if (context.environment === undefined || selection.searchParams.getAll('dshRuntime').length !== 1
        || selection.searchParams.get('dshRuntime') !== context.environment.id || selection.searchParams.getAll('dshTarget').length !== 1
        || selection.searchParams.get('dshTarget') !== expectedScope
        || nodes.length > 1 || nodes.length === 1 && nodes[0] !== context.environment.nodeId) {
        if (res !== null) res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid-prepare-target"}')
        return null
      }
      const endpoint = await instances.liveEndpoint(target) ?? await instances.ensureRunning(context.runtime, 'explicit')
      res?.setHeader('x-dsh-runtime-id', context.environment.id)
      return { ...endpoint, target }
    }
    // Trust the live handle, not the `ready` row: an external kill or crash
    // leaves the row stale, and proxying that port yields instance-unreachable.
    const endpoint = await instances.liveEndpoint(target)
    if (endpoint === null) {
      if (await instances.stopReasonOf(target) === 'manual') {
        if (res !== null) refuseStopped(req, res, target, lang)
        return null
      }
      const gate = await deps.maintenanceGate?.()
      if (gate !== undefined && gate !== 'open') {
        if (res !== null) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: gate })) }
        return null
      }
      const request = instances.startRequest(context.runtime)
      const pending = request.completion
      if (res !== null) {
        await request.admission
        const retryHeaders = { 'cache-control': 'no-store', 'retry-after': '2' }
        if (wantsHtml(req)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...retryHeaders })
          res.end(waitingPage(lang))
        } else {
          res.writeHead(503, { 'content-type': 'application/json', ...retryHeaders })
          res.end(JSON.stringify({
            error: { code: 'INSTANCE_STARTING', message: 'The runtime is starting. Retry shortly.' },
          }))
        }
        pending.catch(error => { console.error(`[gateway] instance start failed for ${target.kind} ${String(target.id)}:`, error) })
        return null
      }
      const running = await pending
      return { ...running, target }
    }
    return endpoint
  }

  function targetOptions(port: number, principal?: string): httpProxy.ServerOptions {
    const authority = `127.0.0.1:${port}`
    return {
      target: `http://${authority}`,
      headers: {
        host: authority,
        origin: `http://${authority}`,
        ...(principal === undefined ? {} : { [PRINCIPAL_HEADER]: principal }),
      },
    }
  }

  const proxyRequest: ProxyHandler = async (req, res, context) => {
    const originalUrl = req.url
    const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
    const lang = gateLanguage(req.headers.cookie)
    delete req.headers[PRINCIPAL_HEADER]
    scrubRuntimeHeaders(req)
    await deps.accessMonitor?.synchronize()
    if (res.destroyed) return
    let ready = await timeOperation('prepare',()=>ensureReady(req, res, context, lang))
    if (ready === null) return
    let operationLease = false
    try {
      if (instances.operationRef !== undefined) {
        // operationRef also updates the activity timestamp while holding the
        // lease, so a separate touch would serialize a redundant DB write.
        await instances.operationRef(ready.target, 1, ready.generation)
        operationLease = true
      } else {
        await instances.touch(ready.target)
      }
    } catch (error) {
      if (!(error instanceof RuntimeLeaseUnavailableError)) throw error
      // The idle reaper may have won the serialized admission race after the
      // liveness check. Start a fresh generation and retry once; forwarding an
      // old port would turn a recoverable race into a misleading 502.
      try {
        const restarted = await instances.ensureRunning(context.runtime)
        ready = { ...restarted, target: ready.target }
        if (instances.operationRef !== undefined) {
          await instances.operationRef(ready.target, 1, ready.generation)
          operationLease = true
        } else {
          await instances.touch(ready.target)
        }
      } catch (error) {
        if (error instanceof RuntimeStartBlockedError) {
          if (error.code === 'INSTANCE_STOPPED') refuseStopped(req, res, ready.target, lang)
          else { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.reason })) }
          return
        }
        const retryHeaders = { 'cache-control': 'no-store', 'retry-after': '2' }
        if (wantsHtml(req)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...retryHeaders })
          res.end(waitingPage(lang))
        } else {
          res.writeHead(503, { 'content-type': 'application/json', ...retryHeaders })
          res.end(JSON.stringify({
            error: { code: 'INSTANCE_STARTING', message: 'The runtime is restarting. Retry shortly.' },
          }))
        }
        return
      }
    }
    try {
      if (!await timeOperation('admit',()=>revalidate(token, context))) {
        if (!res.destroyed) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'access-revoked' }))
        }
        return
      }
      if (res.destroyed) return
      const principal = principalSigner?.issue({
        user: context.user,
        scope: context.scope,
        runtime: { ...ready.target, generation: ready.generation },
      })
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      if (pathname.startsWith('/api/') && !isDocumentUploadDataPath(req.method, pathname)) {
        res.once('finish', () => {
          // Successful RPC traffic is transport noise; only failures are audit-worthy.
          if (res.statusCode < 400) return
          void Promise.resolve(audit.write({
            userId: context.user.id,
            action: 'api',
            methodPath: `${req.method} ${pathname}`,
            status: res.statusCode,
            ip: req.socket.remoteAddress ?? '',
            ...(context.environment === undefined ? {} : { detail: JSON.stringify({
              runtimeId: context.environment.id, nodeId: context.environment.nodeId, generation: ready.generation,
            }) }),
          })).catch(error => { console.error('[gateway] API audit write failed:', error) })
        })
      }
      req.url = runtimeRequestPath(req.url ?? '/')
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          res.removeListener('finish', finish)
          res.removeListener('close', finish)
          resolve()
        }
        // A client can disconnect between admission and listener setup. Also
        // release on `finish`: keep-alive sockets may stay open long after the
        // response has delivered its final byte.
        if (res.destroyed || res.writableFinished) {
          finish()
          return
        }
        res.once('finish', finish)
        res.once('close', finish)
        // Attribute client disconnects: the public tunnel logs a generic
        // "context canceled" without the path, so a close before the response
        // completes gets its own line naming the canceled request.
        res.once('close', () => {
          if (!res.writableFinished) {
            console.error(`[gateway] client disconnected mid-response: ${req.method} ${pathname} -> ${ready.target.kind} ${String(ready.target.id)}`)
          }
        })
        try {
          server.web(req, res, targetOptions(ready.port, principal), () => {
            if (!res.destroyed && !res.headersSent) {
              res.writeHead(502, { 'content-type': 'application/json' })
              res.end(JSON.stringify({
                error: { code: 'INSTANCE_UNREACHABLE', message: 'The runtime is unavailable. Retry shortly.' },
              }))
            } else if (!res.writableEnded && !res.destroyed) {
              res.destroy()
            }
            if (res.destroyed) finish()
          })
        } catch {
          if (!res.headersSent && !res.destroyed) {
            res.writeHead(502, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              error: { code: 'INSTANCE_UNREACHABLE', message: 'The runtime is unavailable. Retry shortly.' },
            }))
          }
          if (res.destroyed) finish()
          else if (!res.writableEnded) res.destroy()
        }
      })
    } finally {
      req.url = originalUrl
      if (operationLease) {
        await Promise.resolve(instances.operationRef?.(ready.target, -1, ready.generation)).catch((error: unknown) => {
          // The response has already settled; retain the lease for the
          // manager's next stop/retry cycle and keep a transient DB failure
          // from replacing a successful user response with an unhandled error.
          console.error('[gateway] HTTP operation lease release failed:', error)
        })
      }
    }
  }

  const upgradeRequest: UpgradeHandler = async (req, socket, head, context) => {
    const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
    const lang = gateLanguage(req.headers.cookie)
    delete req.headers[PRINCIPAL_HEADER]
    scrubRuntimeHeaders(req)
    let ready: { port: number; generation: number; target: RuntimeTarget }
    try {
      await deps.accessMonitor?.synchronize()
      if (socket.destroyed) return
      const resolved = await ensureReady(req, null, context, lang)
      if (resolved === null) throw new Error('runtime did not start')
      ready = resolved
    } catch {
      socket.destroy()
      return
    }
    let admitted = false
    let released = false
    const releaseWebSocketLease = (): void => {
      if (!admitted || released) return
      released = true
      void Promise.resolve(instances.wsRef(ready.target, -1, ready.generation))
        .catch(error => { console.error('[gateway] WebSocket activity update failed:', error) })
    }
    const onSocketClose = (): void => { releaseWebSocketLease() }
    socket.once('close', onSocketClose)
    try {
      await instances.wsRef(ready.target, 1, ready.generation)
      admitted = true
      // The close event may have fired while the serialized admission was
      // waiting. Check the edge explicitly so that a late listener cannot
      // strand the reference forever.
      if (socket.destroyed || socket.readableEnded || socket.writableEnded) {
        releaseWebSocketLease()
        socket.destroy()
        return
      }
    } catch (error) {
      socket.removeListener('close', onSocketClose)
      if (error instanceof RuntimeLeaseUnavailableError) {
        void instances.ensureRunning(context.runtime).catch(() => {})
      }
      socket.destroy()
      return
    }
    try {
      if (!await revalidate(token, context) || socket.destroyed) {
        releaseWebSocketLease()
        socket.destroy()
        return
      }
      const eventConnection = ['/api/events.mux', '/api/events.host'].includes(new URL(req.url ?? '/', 'http://gateway.invalid').pathname)
      let streamLogin: Awaited<ReturnType<typeof qualifyStream>> | undefined
      if (eventConnection && principalSigner !== undefined) {
        streamLogin = token === undefined ? null : await qualifyStream(token, context)
        await deps.accessMonitor?.synchronize()
        if (streamLogin === null || streamLogin.expiresAt <= Date.now() || socket.destroyed) {
          releaseWebSocketLease()
          socket.destroy()
          return
        }
        context.user = streamLogin.user
        context.scope = streamLogin.scope
      }
      const principalInput = {
        user: context.user,
        scope: context.scope,
        runtime: { ...ready.target, generation: ready.generation },
      }
      const principal = eventConnection ? principalSigner?.issueStream(principalInput, streamLogin?.expiresAt) : principalSigner?.issue(principalInput)
      if (eventConnection && principal !== undefined && token !== undefined && streamPrincipals !== undefined) {
        const lifetime = new AbortController()
        const close = (): void => { lifetime.abort() }
        socket.once('close', close)
        socket.once('error', close)
        streamPrincipals.register({ assertion: principal, token, context, signal: lifetime.signal, cancel: () => { socket.destroy() } })
        if (socket.destroyed) lifetime.abort()
      }
      server.ws(req, socket as Duplex & NodeJS.WritableStream, head, targetOptions(ready.port, principal), () => socket.destroy())
    } catch (error: unknown) {
      releaseWebSocketLease()
      socket.destroy(error instanceof Error ? error : undefined)
    }
  }

  const proxy: ProxyHandler = async (req, res, context) => {
    await deps.computerAccess?.authorize(context.user.id)
    const operation = { context, cancel: (): void => { res.destroy() } }
    active.add(operation)
    try { await proxyRequest(req, res, context) } finally { active.delete(operation) }
  }
  const upgrade: UpgradeHandler = async (req, socket, head, context) => {
    await deps.computerAccess?.authorize(context.user.id)
    const operation = { context, cancel: (): void => { socket.destroy() } }
    active.add(operation)
    const release = (): void => { active.delete(operation) }
    socket.once('close', release)
    try { await upgradeRequest(req, socket, head, context) } catch (error: unknown) {
      release()
      socket.destroy()
      throw error
    }
    if (socket.destroyed) release()
  }
  return { proxy, upgrade, invalidateAccess, streamPrincipals, close: () => {
    streamPrincipals?.close()
    unsubscribeAccess?.()
    invalidateAccess({})
    active.clear()
    server.close()
  } }
}
