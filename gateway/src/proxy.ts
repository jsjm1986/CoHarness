import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import httpProxy from 'http-proxy'
import { writeRuntimeGrantsFile } from './apply-grants.ts'
import {
  ensureModelGovernanceForProject,
  ensureModelGovernanceForUser,
  writeModelGovernanceFile,
  writeProjectModelGovernanceFile,
} from './apply-model-governance.ts'
import type { UserRow } from './auth.ts'
import { waitingPage } from './html.ts'
import { RuntimeLeaseUnavailableError, type RuntimeTarget } from './instances.ts'
import { PRINCIPAL_HEADER, type GatewayPrincipalSigner } from './principal.ts'
import { runtimeDirectoryGrants } from './runtime-directory-grants.ts'
import type { GatewayDeps, GatewayRequestContext, ProxyHandler, UpgradeHandler } from './server.ts'

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

export function createProxyHandlers(
  deps: GatewayDeps,
  principalSigner?: GatewayPrincipalSigner,
): { proxy: ProxyHandler; upgrade: UpgradeHandler; close(): void } {
  const { cfg, instances, audit, projects } = deps
  const server = httpProxy.createProxyServer({
    xfwd: true,
    proxyTimeout: cfg.upstreamTimeoutMs,
    timeout: cfg.upstreamTimeoutMs,
  })
  server.on('proxyRes', (proxyResponse) => {
    const location = proxyResponse.headers.location
    if (typeof location === 'string') {
      const rewritten = publicLocation(location)
      if (rewritten !== location) proxyResponse.headers.location = rewritten
    }
  })

  // Grants handoff is intrinsic to starting an instance: the manager calls this
  // just before every spawn, so the child always reads the current grants.
  instances.beforeStart = async (runtime): Promise<void> => {
    if (runtime.user !== undefined) {
      writeRuntimeGrantsFile(runtime.dshHome, await runtimeDirectoryGrants(runtime.user, projects), cfg.usersRoot)
      if (deps.governance !== undefined) await writeModelGovernanceFile(cfg, deps.governance, runtime.user)
      return
    }
    if (runtime.project === undefined) throw new Error(`runtime ${runtime.runtimeKey} has no owner facts`)
    writeRuntimeGrantsFile(runtime.dshHome, [{
      path: runtime.project.path,
      mode: 'rw',
      label: runtime.project.name,
    }], cfg.projectRuntimesRoot)
    if (deps.governance !== undefined) {
      await writeProjectModelGovernanceFile(cfg, deps.governance, runtime.project)
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

  const targetFor = (context: GatewayRequestContext): RuntimeTarget => 'username' in context.runtime
    ? { kind: 'user', id: context.runtime.id }
    : { kind: 'project', id: context.runtime.id }

  async function ensureReady(
    req: IncomingMessage,
    res: ServerResponse | null,
    context: GatewayRequestContext,
  ): Promise<{ port: number; generation: number; target: RuntimeTarget } | null> {
    const target = targetFor(context)
    // Trust the live handle, not the `ready` row: an external kill or crash
    // leaves the row stale, and proxying that port yields instance-unreachable.
    if (!await instances.isLive(target)) {
      const pending = instances.ensureRunning(context.runtime)
      if (res !== null) {
        const retryHeaders = { 'cache-control': 'no-store', 'retry-after': '2' }
        if (wantsHtml(req)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...retryHeaders })
          res.end(waitingPage())
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
    return {
      port: await instances.portOf(target),
      generation: await instances.generationOf(target),
      target,
    }
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

  const proxy: ProxyHandler = async (req, res, context) => {
    delete req.headers[PRINCIPAL_HEADER]
    scrubRuntimeHeaders(req)
    let ready = await ensureReady(req, res, context)
    if (ready === null) return
    await instances.touch(ready.target)
    let operationLease = false
    try {
      await instances.operationRef?.(ready.target, 1, ready.generation)
      operationLease = instances.operationRef !== undefined
    } catch (error) {
      if (!(error instanceof RuntimeLeaseUnavailableError)) throw error
      // The idle reaper may have won the serialized admission race after the
      // liveness check. Start a fresh generation and retry once; forwarding an
      // old port would turn a recoverable race into a misleading 502.
      try {
        const restarted = await instances.ensureRunning(context.runtime)
        ready = { ...restarted, target: ready.target }
        await instances.operationRef?.(ready.target, 1, ready.generation)
        operationLease = instances.operationRef !== undefined
      } catch {
        const retryHeaders = { 'cache-control': 'no-store', 'retry-after': '2' }
        if (wantsHtml(req)) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...retryHeaders })
          res.end(waitingPage())
        } else {
          res.writeHead(503, { 'content-type': 'application/json', ...retryHeaders })
          res.end(JSON.stringify({
            error: { code: 'INSTANCE_STARTING', message: 'The runtime is restarting. Retry shortly.' },
          }))
        }
        return
      }
    }
    const principal = principalSigner?.issue({
      user: context.user,
      scope: context.scope,
      runtime: { kind: ready.target.kind, id: ready.target.id, generation: ready.generation },
    })
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (pathname.startsWith('/api/') && !isDocumentUploadDataPath(req.method, pathname)) {
      res.once('finish', () => {
        void Promise.resolve(audit.write({
          userId: context.user.id,
          action: 'api',
          methodPath: `${req.method} ${pathname}`,
          status: res.statusCode,
          ip: req.socket.remoteAddress ?? '',
        })).catch(error => { console.error('[gateway] API audit write failed:', error) })
      })
    }
    try {
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
        try {
          server.web(req, res, targetOptions(ready.port, principal), () => {
            if (!res.headersSent) {
              res.writeHead(502, { 'content-type': 'application/json' })
              res.end(JSON.stringify({
                error: { code: 'INSTANCE_UNREACHABLE', message: 'The runtime is unavailable. Retry shortly.' },
              }))
            } else if (!res.writableEnded && !res.destroyed) {
              res.end()
            }
            if (res.destroyed) finish()
          })
        } catch (error) {
          if (!res.headersSent && !res.destroyed) {
            res.writeHead(502, { 'content-type': 'application/json' })
            res.end(JSON.stringify({
              error: { code: 'INSTANCE_UNREACHABLE', message: 'The runtime is unavailable. Retry shortly.' },
            }))
          }
          if (res.destroyed) finish()
          else if (error instanceof Error && !res.writableEnded) res.end()
        }
      })
    } finally {
      if (operationLease) await instances.operationRef?.(ready.target, -1, ready.generation)
    }
  }

  const upgrade: UpgradeHandler = async (req, socket, head, context) => {
    delete req.headers[PRINCIPAL_HEADER]
    scrubRuntimeHeaders(req)
    let ready: { port: number; generation: number; target: RuntimeTarget }
    try {
      const resolved = await ensureReady(req, null, context)
      if (resolved === null) throw new Error('runtime did not start')
      ready = resolved
    } catch {
      socket.destroy()
      return
    }
    await instances.touch(ready.target)
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
    const principal = principalSigner?.issue({
      user: context.user,
      scope: context.scope,
      runtime: { kind: ready.target.kind, id: ready.target.id, generation: ready.generation },
    })
    server.ws(req, socket as Duplex & NodeJS.WritableStream, head, targetOptions(ready.port, principal), () => socket.destroy())
  }

  return { proxy, upgrade, close: () => server.close() }
}
