/** Read-only delivery of revisioned Runtime resources under current browser and generation authority. */
import { request, type IncomingMessage, type ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { GatewayAccessMonitor, AccessInvalidationSubject } from './access-invalidation.ts'
import type { UserRow } from './auth.ts'
import { RuntimeLeaseUnavailableError, type InstanceManager } from './instances.ts'
import type { GatewayPrincipalSigner } from './principal.ts'
import { RuntimeAssetUnavailableError, type RuntimeAssetAdmission, type RuntimeAssetRequest } from './runtime-asset-admission.ts'
import { isImmutableRuntimeAssetRequest, pinRuntimeRequestPath, runtimeRequestPath } from './runtime-request-path.ts'
import { nodeUuidSchema } from './node-access.ts'
import { NODE_SERVICE_TARGET_HEADER } from './node-service-stream.ts'
import { parseCookies, SESSION_COOKIE } from './server.ts'
import type { RuntimeId, RuntimeNodeId } from './runtime-catalog.ts'
import type { RuntimePlacement } from './runtime-router.ts'
import { httpConnectionFields } from './http-connection-fields.ts'

/** Existing authority, lifecycle and forwarding owners used by immutable resource dispatch. */
export interface RuntimeAssetsOptions {
  cfg: { publicOrigins: string[]; upstreamTimeoutMs: number }
  localNodeId: RuntimeNodeId
  admission: { admit(request: RuntimeAssetRequest): Promise<RuntimeAssetAdmission> }
  instances: Pick<InstanceManager, 'retainAsset'>
  monitor: GatewayAccessMonitor
  signer: GatewayPrincipalSigner
  /** Existing bounded node transport; omitted on an independent computer. */
  forward?: (request: IncomingMessage, response: ServerResponse, actor: UserRow,
    placement: RuntimePlacement & { environment: NonNullable<RuntimePlacement['environment']> }) => Promise<boolean>
}

interface ActiveAsset { nodeId?: RuntimeNodeId; userId: number; projectId?: number; qualified: boolean; cancel(): void }

/** Owns resource responses and revocation listeners without granting execution authority. */
export class RuntimeAssets {
  private readonly active = new Set<ActiveAsset>()
  private readonly work = new Set<Promise<unknown>>()
  private readonly unsubscribe: () => void
  private closed = false

  /** @param options - current node authority and the existing transport/lifecycle providers. */
  constructor(private readonly options: RuntimeAssetsOptions) {
    this.unsubscribe = options.monitor.subscribe(subject => { this.invalidate(subject) })
  }

  private invalidate(subject: AccessInvalidationSubject): void {
    for (const operation of this.active) {
      if (subject.nodeId !== undefined && operation.nodeId !== undefined && subject.nodeId !== operation.nodeId) continue
      if (subject.userId !== undefined && subject.userId !== operation.userId) continue
      if (subject.projectId !== undefined && operation.qualified && subject.projectId !== operation.projectId) continue
      operation.cancel()
    }
  }

  /**
   * Serve a strict immutable request when it names an exact Runtime, explicitly or through a same-origin Referer.
   * @param req - current request; ordinary API and unversioned resources return false untouched.
   * @param res - response retained through revocation, transport completion and reference release.
   * @param actor - already authenticated browser identity; the asset query rechecks its session and permissions.
   * @param entryNodeId - verified forwarding issuer; omission uses this Gateway's own ingress scope.
   * @returns true when this handler owns the response; false uses the existing execution route.
   */
  handle(req: IncomingMessage, res: ServerResponse, actor: UserRow, entryNodeId?: RuntimeNodeId): Promise<boolean> {
    const operation = this.serve(req, res, actor, entryNodeId)
    this.work.add(operation)
    void operation.then(() => { this.work.delete(operation) }, () => { this.work.delete(operation) })
    return operation
  }

  private async serve(req: IncomingMessage, res: ServerResponse, actor: UserRow, entryNodeId?: RuntimeNodeId): Promise<boolean> {
    if (!isImmutableRuntimeAssetRequest(req.method, req.url ?? '/')) return false
    const url = new URL(req.url ?? '/', 'http://gateway')
    if (!url.searchParams.has('dshRuntime') && req.headers.referer !== undefined) {
      let referer: URL
      try { referer = new URL(req.headers.referer) } catch { return false }
      if (this.options.cfg.publicOrigins.includes(referer.origin) || referer.host === req.headers.host) {
        const ids = referer.searchParams.getAll('dshRuntime')
        if (ids.length === 1) {
          req.url = pinRuntimeRequestPath(req.url ?? '/', ids[0]! as RuntimeId)
          url.searchParams.set('dshRuntime', ids[0]!)
        }
      }
    }
    const ids = url.searchParams.getAll('dshRuntime')
    if (ids.length === 0) return false
    const nodes = url.searchParams.getAll('dshNode'), targets = url.searchParams.getAll('dshTarget')
    const target = targets[0]
    if (ids.length !== 1 || !nodeUuidSchema.safeParse(ids[0]).success || nodes.length > 1
      || nodes.length === 1 && !nodeUuidSchema.safeParse(nodes[0]).success || targets.length > 1
      || target !== undefined && target !== 'personal' && (!/^project:[1-9][0-9]*$/u.test(target) || !Number.isSafeInteger(Number(target.slice(8))))) {
      this.refuse(res, 400, 'runtime-asset/invalid-target')
      return true
    }
    const runtimeId = ids[0]! as RuntimeId
    const sessionToken = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
    if (sessionToken === undefined) { this.refuse(res, 403, 'runtime-asset/forbidden'); return true }
    if (this.closed || !this.options.monitor.available || this.options.monitor.synchronizeTo === undefined) {
      this.refuse(res, 503, 'runtime-asset/authority-unavailable'); return true
    }
    const owner = new AbortController()
    const cancel = (): void => { owner.abort(); if (!res.writableFinished) res.destroy() }
    const active: ActiveAsset = { userId: actor.id, qualified: false, cancel }
    const disconnected = (): void => { if (!res.writableFinished) cancel() }
    this.active.add(active)
    req.once('aborted', cancel); res.once('close', disconnected)
    if (req.aborted || res.destroyed) cancel()
    let release: (() => void) | undefined
    let expires: NodeJS.Timeout | undefined
    try {
      const qualify = async (): Promise<RuntimeAssetAdmission> => {
        owner.signal.throwIfAborted()
        const admitted = await this.options.admission.admit({ actorId: actor.id, sessionToken, runtimeId,
          ...(nodes[0] === undefined ? {} : { nodeId: nodes[0] as RuntimeNodeId }),
          ...(target === undefined ? {} : { target: target as RuntimePlacement['target'] }),
          ...(entryNodeId === undefined ? {} : { entryNodeId }) })
        owner.signal.throwIfAborted()
        return admitted
      }
      const retained = await this.options.instances.retainAsset(runtimeId, qualify)
      release = retained?.release
      const admission = retained?.admission ?? await qualify()
      const { placement, snapshot } = admission
      if (placement.local !== (placement.environment.node.id === this.options.localNodeId)) {
        throw new RuntimeAssetUnavailableError(409, 'runtime-asset/target-mismatch')
      }
      const principals = url.searchParams.getAll('dshPrincipal'), expectedPrincipal = req.headers['x-dsh-expected-principal-id']
      if (principals.length > 1 || principals.length === 1 && principals[0] !== String(admission.user.id)
        || expectedPrincipal !== undefined && expectedPrincipal !== String(admission.user.id)) {
        throw new RuntimeAssetUnavailableError(409, 'account-changed')
      }
      active.nodeId = placement.environment.node.id
      if (admission.scope.kind === 'project') active.projectId = admission.scope.projectId
      active.qualified = true
      if (admission.expiresAt <= Date.now() || !await this.options.monitor.synchronizeTo(BigInt(admission.accessRevision))) {
        throw new RuntimeAssetUnavailableError(503, 'runtime-asset/authority-changed')
      }
      owner.signal.throwIfAborted()
      if (this.closed || admission.expiresAt <= Date.now()) throw new RuntimeAssetUnavailableError(503, 'runtime-asset/authority-changed')
      expires = setTimeout(cancel, Math.min(2_147_483_647, admission.expiresAt - Date.now()))
      expires.unref()
      const expectedNode = req.headers[NODE_SERVICE_TARGET_HEADER]
      if (expectedNode !== undefined && (expectedNode !== placement.environment.node.id || !placement.local)) {
        throw new RuntimeAssetUnavailableError(409, 'runtime-asset/target-mismatch')
      }
      if (!placement.local) {
        if (this.options.forward === undefined || !await this.options.forward(req, res, admission.user, placement)) {
          throw new RuntimeAssetUnavailableError(503, 'runtime-asset/unavailable')
        }
        return true
      }
      if (retained === null) throw new RuntimeAssetUnavailableError(503, 'runtime-asset/unavailable')
      const path = runtimeRequestPath(req.url ?? '/')
      const assertion = this.options.signer.issueAsset({ user: admission.user, scope: admission.scope,
        runtime: { ...snapshot.target, generation: snapshot.generation }, method: req.method as 'GET' | 'HEAD', path }, admission.expiresAt)
      await this.forwardLocal(req, res, snapshot.port, path, assertion, owner.signal)
      return true
    } catch (error) {
      if (owner.signal.aborted || res.destroyed) return true
      if (error instanceof RuntimeAssetUnavailableError) this.refuse(res, error.status, error.code)
      else if (error instanceof RuntimeLeaseUnavailableError) this.refuse(res, 503, 'runtime-asset/unavailable')
      else throw error
      return true
    } finally {
      req.removeListener('aborted', cancel); res.removeListener('close', disconnected)
      if (expires !== undefined) clearTimeout(expires)
      release?.(); this.active.delete(active)
    }
  }

  private refuse(res: ServerResponse, status: number, code: string): void {
    if (res.headersSent) { res.destroy(); return }
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: code }))
  }

  private async forwardLocal(req: IncomingMessage, res: ServerResponse, port: number, path: string, assertion: string, signal: AbortSignal): Promise<void> {
    const headers: Record<string, string> = {
      host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'x-dsh-gateway-principal': assertion,
    }
    for (const name of ['accept', 'accept-encoding', 'if-none-match', 'if-modified-since', 'range', 'if-range']) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    const upstream = request({ hostname: '127.0.0.1', port, path, method: req.method, headers, signal })
    const closed = new Promise<void>(resolve => { upstream.once('close', resolve) })
    const timer = setTimeout(() => { upstream.destroy(new Error('Runtime resource headers timed out')) }, this.options.cfg.upstreamTimeoutMs)
    timer.unref()
    let response: IncomingMessage | undefined
    try {
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        upstream.once('error', reject)
        upstream.once('response', resolve)
        upstream.end()
      })
      clearTimeout(timer)
      delete response.headers['set-cookie']
      delete response.headers['x-dsh-runtime-id']
      delete response.headers[NODE_SERVICE_TARGET_HEADER]
      for (const name of httpConnectionFields(response.headers.connection)) delete response.headers[name]
      signal.throwIfAborted()
      res.writeHead(response.statusCode ?? 502, response.headers)
      await pipeline(response, res, { signal })
    } catch (error) {
      if (signal.aborted) throw error
      this.refuse(res, 502, 'runtime-asset/upstream-unavailable')
    } finally {
      clearTimeout(timer)
      response?.destroy(); upstream.destroy()
      await closed
    }
  }

  /** Refuse new reads, cancel owned responses, and await their generation-reference release. */
  async close(): Promise<void> {
    this.closed = true
    this.unsubscribe()
    for (const operation of this.active) operation.cancel()
    await Promise.allSettled([...this.work])
  }
}
