/** Read-only delivery of revisioned Runtime resources under current browser and generation authority. */
import { request, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import Negotiator from 'negotiator'
import type { GatewayAccessMonitor, AccessInvalidationSubject } from './access-invalidation.ts'
import type { UserRow } from './auth.ts'
import { RuntimeLeaseUnavailableError, type InstanceManager } from './instances.ts'
import type { GatewayPrincipalSigner } from './principal.ts'
import { RuntimeAssetUnavailableError, type RuntimeAssetAdmission, type RuntimeAssetRequest } from './runtime-asset-admission.ts'
import { BROWSER_RUNTIME_ASSET_CACHE_CONTROL, isImmutableRuntimeAssetRequest, pinRuntimeRequestPath, runtimeRequestPath } from './runtime-request-path.ts'
import { nodeUuidSchema } from './node-access.ts'
import { NODE_SERVICE_ASSET_GENERATION_HEADER, NODE_SERVICE_TARGET_HEADER, RELEASE_COMBO_DIGEST_HEADER } from './node-service-stream.ts'
import { parseCookies, SESSION_COOKIE } from './server.ts'
import type { RuntimeId, RuntimeNodeId } from './runtime-catalog.ts'
import type { RuntimePlacement } from './runtime-router.ts'
import { httpConnectionFields } from './http-connection-fields.ts'
import { compressBuffer, compressImmutableBuffer, isCompressibleContentType, MIN_COMPRESS_BYTES, preferredCompression, type ContentCoding } from './http-compression.ts'
import type { RemoteAssetCapture, RemoteAssetDelivery } from './node-service-proxy.ts'
import type { LocalReleaseCombo, ReleaseComboReader } from './release-combos.ts'

const DEFAULT_REMOTE_CACHE_MAX_BYTES = 32 * 1024 * 1024
const REMOTE_CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024
const REMOTE_CACHE_MAX_ENTRIES = 128
const RELEASE_ENCODED_CACHE_MAX_BYTES = 16 * 1024 * 1024
const RELEASE_ENCODED_CACHE_MAX_ENTRIES = 64
const RELEASE_ENCODING_MAX_JOBS = 2
const RELEASE_ENCODING_MAX_INPUT_BYTES = 8 * 1024 * 1024

/** Identifier-free asset cache counters and current release compression occupancy. */
export interface RuntimeAssetCacheDiagnostics {
  readonly remoteCacheHits: number
  readonly remoteCacheMisses: number
  readonly remoteCacheEntries: number
  readonly remoteCacheBytes: number
  readonly releaseEncodedHits: number
  readonly releaseEncodedMisses: number
  readonly releaseEncodedEntries: number
  readonly releaseEncodedBytes: number
  readonly releaseEncodingInFlight: number
  readonly releaseEncodingInFlightBytes: number
}

/** Existing authority, lifecycle and forwarding owners used by immutable resource dispatch. */
export interface RuntimeAssetsOptions {
  cfg: { publicOrigins: string[]; upstreamTimeoutMs: number; runtimeAssetCacheMaxBytes?: number }
  localNodeId: RuntimeNodeId
  admission: { admit(request: RuntimeAssetRequest): Promise<RuntimeAssetAdmission> }
  instances: Pick<InstanceManager, 'retainAsset'>
  monitor: GatewayAccessMonitor
  signer: GatewayPrincipalSigner
  /** Optional immutable installation reader. A read here supplies bytes, never authority. */
  releaseCombo?: ReleaseComboReader
  /** Existing bounded node transport; omitted on an independent computer. */
  forward?: (request: IncomingMessage, response: ServerResponse, actor: UserRow,
    placement: RuntimePlacement & { environment: NonNullable<RuntimePlacement['environment']> },
    generation: number, delivery?: RemoteAssetDelivery) => Promise<boolean>
}

interface ActiveAsset { nodeId?: RuntimeNodeId; userId: number; projectId?: number; qualified: boolean; cancel(): void }

type StoredCoding = 'identity' | ContentCoding

interface RemoteAssetOwner {
  readonly nodeId: RuntimeNodeId
  readonly userId: number
  readonly projectId?: number
}

interface CachedRemoteAsset extends RemoteAssetOwner {
  readonly contentType: string
  readonly etag?: string
  readonly freshUntil: number
  readonly variants: Partial<Record<StoredCoding, Buffer>>
  bytes: number
}

/** Owns resource responses and revocation listeners without granting execution authority. */
export class RuntimeAssets {
  private readonly active = new Set<ActiveAsset>()
  private readonly work = new Set<Promise<unknown>>()
  private readonly remoteCache = new Map<string, CachedRemoteAsset>()
  private readonly remoteCacheMaxBytes: number
  private remoteCacheBytes = 0
  private remoteCacheHits = 0
  private remoteCacheMisses = 0
  private readonly releaseEncodedCache = new Map<string, Buffer | null>()
  private readonly releaseEncodingInFlight = new Map<string, Promise<Buffer | null>>()
  private releaseEncodingInFlightBytes = 0
  private readonly releaseEncodedMaxBytes: number
  private releaseEncodedBytes = 0
  private releaseEncodedHits = 0
  private releaseEncodedMisses = 0
  private readonly unsubscribe: () => void
  private closing?: Promise<void>

  private get closed(): boolean { return this.closing !== undefined }

  /** @param options - current node authority and the existing transport/lifecycle providers. */
  constructor(private readonly options: RuntimeAssetsOptions) {
    this.remoteCacheMaxBytes = options.cfg.runtimeAssetCacheMaxBytes ?? DEFAULT_REMOTE_CACHE_MAX_BYTES
    this.releaseEncodedMaxBytes = Math.min(RELEASE_ENCODED_CACHE_MAX_BYTES, this.remoteCacheMaxBytes)
    this.unsubscribe = options.monitor.subscribe(subject => { this.invalidate(subject) })
  }

  /** @returns cumulative Center-side remote immutable asset cache metrics without identifiers. */
  diagnostics(): RuntimeAssetCacheDiagnostics {
    return {
      remoteCacheHits: this.remoteCacheHits,
      remoteCacheMisses: this.remoteCacheMisses,
      remoteCacheEntries: this.remoteCache.size,
      remoteCacheBytes: this.remoteCacheBytes,
      releaseEncodedHits: this.releaseEncodedHits,
      releaseEncodedMisses: this.releaseEncodedMisses,
      releaseEncodedEntries: this.releaseEncodedCache.size,
      releaseEncodedBytes: this.releaseEncodedBytes,
      releaseEncodingInFlight: this.releaseEncodingInFlight.size,
      releaseEncodingInFlightBytes: this.releaseEncodingInFlightBytes,
    }
  }

  private invalidate(subject: AccessInvalidationSubject): void {
    for (const [key, entry] of this.remoteCache) {
      if (subject.nodeId !== undefined && subject.nodeId !== entry.nodeId) continue
      if (subject.userId !== undefined && subject.userId !== entry.userId) continue
      if (subject.projectId !== undefined && subject.projectId !== entry.projectId) continue
      this.remoteCacheBytes = Math.max(0, this.remoteCacheBytes - entry.bytes)
      this.remoteCache.delete(key)
    }
    for (const operation of this.active) {
      if (subject.nodeId !== undefined && operation.nodeId !== undefined && subject.nodeId !== operation.nodeId) continue
      if (subject.userId !== undefined && subject.userId !== operation.userId) continue
      if (subject.projectId !== undefined && operation.qualified && subject.projectId !== operation.projectId) continue
      operation.cancel()
    }
  }

  private storeRemoteVariant(key: string, owner: RemoteAssetOwner, captured: {
    readonly contentType: string
    readonly etag?: string
    readonly freshUntil: number
    readonly contentEncoding?: string
    readonly body: Buffer
  }): void {
    if (this.closed || captured.freshUntil <= Date.now() || this.remoteCacheMaxBytes <= 0
      || captured.body.byteLength > REMOTE_CACHE_MAX_ENTRY_BYTES) return
    const coding: StoredCoding | undefined = captured.contentEncoding === undefined || captured.contentEncoding === 'identity'
      ? 'identity'
      : captured.contentEncoding === 'br' || captured.contentEncoding === 'gzip' ? captured.contentEncoding : undefined
    if (coding === undefined) return
    const existing = this.remoteCache.get(key)
    if (existing !== undefined && existing.freshUntil > Date.now() && existing.etag === captured.etag
      && existing.contentType === captured.contentType) {
      const prev = existing.variants[coding]
      const delta = captured.body.byteLength - (prev?.byteLength ?? 0)
      if (existing.bytes + delta > REMOTE_CACHE_MAX_ENTRY_BYTES) return
      existing.variants[coding] = captured.body
      existing.bytes += delta
      this.remoteCacheBytes += delta
      this.remoteCache.delete(key)
      this.remoteCache.set(key, existing)
    } else {
      if (existing !== undefined) {
        this.remoteCacheBytes = Math.max(0, this.remoteCacheBytes - existing.bytes)
        this.remoteCache.delete(key)
      }
      const entry: CachedRemoteAsset = {
        ...owner,
        contentType: captured.contentType,
        freshUntil: captured.freshUntil,
        ...(captured.etag === undefined ? {} : { etag: captured.etag }),
        variants: { [coding]: captured.body },
        bytes: captured.body.byteLength,
      }
      this.remoteCache.set(key, entry)
      this.remoteCacheBytes += entry.bytes
    }
    this.evictRemoteCache()
  }

  private evictRemoteCache(): void {
    while (this.remoteCache.size > REMOTE_CACHE_MAX_ENTRIES || this.remoteCacheBytes > this.remoteCacheMaxBytes) {
      const oldest = this.remoteCache.entries().next().value as [string, CachedRemoteAsset] | undefined
      if (oldest === undefined) break
      this.remoteCache.delete(oldest[0])
      this.remoteCacheBytes = Math.max(0, this.remoteCacheBytes - oldest[1].bytes)
    }
  }

  private storeReleaseEncoded(key: string, encoded: Buffer | null): void {
    const previous = this.releaseEncodedCache.get(key)
    if (previous !== undefined) {
      if (previous !== null) this.releaseEncodedBytes = Math.max(0, this.releaseEncodedBytes - previous.byteLength)
      this.releaseEncodedCache.delete(key)
    }
    this.releaseEncodedCache.set(key, encoded)
    if (encoded !== null) this.releaseEncodedBytes += encoded.byteLength
    while (this.releaseEncodedCache.size > RELEASE_ENCODED_CACHE_MAX_ENTRIES || this.releaseEncodedBytes > this.releaseEncodedMaxBytes) {
      const oldest = this.releaseEncodedCache.entries().next().value as [string, Buffer | null] | undefined
      if (oldest === undefined) break
      this.releaseEncodedCache.delete(oldest[0])
      if (oldest[1] !== null) this.releaseEncodedBytes = Math.max(0, this.releaseEncodedBytes - oldest[1].byteLength)
    }
  }

  private startReleaseEncoding(candidate: LocalReleaseCombo, coding: ContentCoding): { promise: Promise<Buffer | null>; started: boolean } | undefined {
    if (this.closed || this.releaseEncodedMaxBytes <= 0) return undefined
    const key = `${candidate.sha256}:${coding}`
    const cached = this.releaseEncodedCache.get(key)
    if (cached !== undefined) {
      this.releaseEncodedCache.delete(key)
      this.releaseEncodedCache.set(key, cached)
      return { promise: Promise.resolve(cached), started: false }
    }
    const inFlight = this.releaseEncodingInFlight.get(key)
    if (inFlight !== undefined) return { promise: inFlight, started: false }
    const bytes = candidate.body.byteLength
    if (this.releaseEncodingInFlight.size >= RELEASE_ENCODING_MAX_JOBS
      || this.releaseEncodingInFlightBytes + bytes > RELEASE_ENCODING_MAX_INPUT_BYTES) return undefined
    this.releaseEncodedMisses += 1
    this.releaseEncodingInFlightBytes += bytes
    const work = compressImmutableBuffer(candidate.body, coding).then(compressed => {
      const stored = compressed.byteLength < bytes ? compressed : null
      if (!this.closed && (stored === null || stored.byteLength <= this.releaseEncodedMaxBytes)) {
        this.storeReleaseEncoded(key, stored)
      }
      return stored
    }).finally(() => {
      this.releaseEncodingInFlight.delete(key)
      this.releaseEncodingInFlightBytes -= bytes
    })
    this.releaseEncodingInFlight.set(key, work)
    return { promise: work, started: true }
  }

  private warmReleaseEncoding(candidate: LocalReleaseCombo, coding: ContentCoding): boolean {
    if (this.closed || this.releaseEncodedMaxBytes <= 0) return false
    const key = `${candidate.sha256}:${coding}`
    if (this.releaseEncodedCache.has(key) || this.releaseEncodingInFlight.has(key)) return false
    const encoding = this.startReleaseEncoding(candidate, coding)
    if (encoding === undefined) return false
    void encoding.promise.catch(() => { /* Compression failures surface to active waiters without creating unhandled rejections. */ })
    return encoding.started
  }

  private async encodeReleaseCandidate(
    candidate: LocalReleaseCombo,
    coding: ContentCoding,
    signal: AbortSignal,
    prewarmed: boolean,
  ): Promise<Buffer | undefined> {
    signal.throwIfAborted()
    const encoding = this.startReleaseEncoding(candidate, coding)
    if (encoding === undefined) return undefined
    const { promise, started } = encoding
    if (!started && !prewarmed) this.releaseEncodedHits += 1
    const result = await new Promise<Buffer | null>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return }
      const onAbort = (): void => { reject(signal.reason) }
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        value => { signal.removeEventListener('abort', onAbort); resolve(value) },
        error => { signal.removeEventListener('abort', onAbort); reject(error) },
      )
    })
    signal.throwIfAborted()
    return result ?? undefined
  }

  private async serveCachedRemote(req: IncomingMessage, res: ServerResponse, key: string, signal: AbortSignal): Promise<boolean> {
    if (this.remoteCacheMaxBytes <= 0 || req.headers.range !== undefined) return false
    const entry = this.remoteCache.get(key)
    if (entry === undefined) return false
    this.remoteCache.delete(key)
    if (entry.freshUntil <= Date.now()) {
      this.remoteCacheBytes = Math.max(0, this.remoteCacheBytes - entry.bytes)
      return false
    }
    this.remoteCache.set(key, entry)
    const rawIfNoneMatch = req.headers['if-none-match']
    if (entry.etag !== undefined && typeof rawIfNoneMatch === 'string') {
      const normalized = entry.etag.startsWith('W/') ? entry.etag.slice(2) : entry.etag
      const matched = rawIfNoneMatch.split(',').some(candidate => {
        const trimmed = candidate.trim()
        return trimmed === '*' || trimmed === entry.etag || (trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed) === normalized
      })
      if (matched) {
        this.remoteCacheHits += 1
        res.writeHead(304, {
          etag: entry.etag,
          vary: 'accept-encoding',
          'cache-control': BROWSER_RUNTIME_ASSET_CACHE_CONTROL,
        })
        res.end()
        return true
      }
    }
    const preferred = preferredCompression(req.headers['accept-encoding'])
    let body: Buffer | undefined
    let encoding: ContentCoding | undefined
    let derivedFromIdentity = false
    if (preferred !== undefined && entry.variants[preferred] !== undefined) {
      body = entry.variants[preferred]
      encoding = preferred
      derivedFromIdentity = entry.variants.identity !== undefined
    } else if (entry.variants.identity !== undefined) {
      const identity = entry.variants.identity
      if (preferred !== undefined && identity.byteLength >= MIN_COMPRESS_BYTES && isCompressibleContentType(entry.contentType)) {
        const compressed = await compressBuffer(identity, preferred)
        signal.throwIfAborted()
        if (compressed.byteLength < identity.byteLength) {
          body = compressed
          encoding = preferred
          derivedFromIdentity = true
          if (this.remoteCache.get(key) === entry && entry.variants[preferred] === undefined
            && entry.bytes + compressed.byteLength <= REMOTE_CACHE_MAX_ENTRY_BYTES) {
            entry.variants[preferred] = compressed
            entry.bytes += compressed.byteLength
            this.remoteCacheBytes += compressed.byteLength
            this.evictRemoteCache()
          }
        } else {
          body = identity
        }
      } else {
        body = identity
      }
    } else if (preferred !== undefined) {
      // Client accepts an encoding we already cached (e.g. br cached, client accepts br + gzip).
      const rawAccept = Array.isArray(req.headers['accept-encoding'])
        ? req.headers['accept-encoding'].join(',') : (req.headers['accept-encoding'] ?? '')
      for (const candidate of ['br', 'gzip'] as const) {
        if (entry.variants[candidate] !== undefined && preferredCompression(
          rawAccept.split(',').filter(part => part.trim().toLowerCase().startsWith(candidate) || part.trim().startsWith('*')).join(','),
        ) === candidate) {
          body = entry.variants[candidate]
          encoding = candidate
          break
        }
      }
    }
    if (body === undefined) return false
    const responseEtag = entry.etag === undefined ? undefined
      : (derivedFromIdentity && encoding !== undefined && !entry.etag.startsWith('W/') ? `W/${entry.etag}` : entry.etag)
    this.remoteCacheHits += 1
    res.writeHead(200, {
      'content-type': entry.contentType,
      'content-length': body.byteLength,
      vary: 'accept-encoding',
      'cache-control': BROWSER_RUNTIME_ASSET_CACHE_CONTROL,
      ...(encoding === undefined ? {} : { 'content-encoding': encoding }),
      ...(responseEtag === undefined ? {} : { etag: responseEtag }),
    })
    if (req.method === 'HEAD') res.end()
    else res.end(body)
    return true
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
    const path = runtimeRequestPath(req.url ?? '/', req.method)
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
    const monitor = this.options.monitor
    const synchronizeTo = monitor.synchronizeTo?.bind(monitor)
    if (this.closed || !monitor.available || synchronizeTo === undefined) {
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
      if (admission.expiresAt <= Date.now() || !await synchronizeTo(BigInt(admission.accessRevision))) {
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
        const cacheOwner: RemoteAssetOwner = { nodeId: placement.environment.node.id, userId: admission.user.id,
          ...(admission.scope.kind === 'project' ? { projectId: admission.scope.projectId } : {}) }
        const cacheKey = JSON.stringify([cacheOwner.nodeId, runtimeId, snapshot.generation, snapshot.launchStamp,
          snapshot.startedAt, cacheOwner.userId, cacheOwner.projectId ?? null, path])
        if (await this.serveCachedRemote(req, res, cacheKey, owner.signal)) return true
        if (this.options.forward === undefined) {
          throw new RuntimeAssetUnavailableError(503, 'runtime-asset/unavailable')
        }
        if (this.remoteCacheMaxBytes > 0 && req.headers.range === undefined) this.remoteCacheMisses += 1
        const capture: RemoteAssetCapture | undefined = this.remoteCacheMaxBytes > 0 && req.method === 'GET' && req.headers.range === undefined
          ? {
            maxBytes: Math.min(REMOTE_CACHE_MAX_ENTRY_BYTES, this.remoteCacheMaxBytes),
            onComplete: captured => {
              if (!owner.signal.aborted) this.storeRemoteVariant(cacheKey, cacheOwner, captured)
            },
          }
          : undefined
        const candidate = this.options.releaseCombo !== undefined && req.method === 'GET' && req.headers.range === undefined
          && req.headers['if-none-match'] === undefined && req.headers['if-modified-since'] === undefined
          && req.headers['if-match'] === undefined && req.headers['if-unmodified-since'] === undefined
          && new Negotiator(req).encoding(['identity']) === 'identity'
          ? await this.options.releaseCombo(path) : undefined
        owner.signal.throwIfAborted()
        const releaseCoding = candidate === undefined ? undefined : preferredCompression(req.headers['accept-encoding'])
        const releasePrewarmed = candidate !== undefined && releaseCoding !== undefined
          ? this.warmReleaseEncoding(candidate, releaseCoding) : false
        const release: RemoteAssetDelivery['release'] = candidate === undefined ? undefined : {
          sha256: candidate.sha256,
          serve: async forwardSignal => {
            const deliverySignal = AbortSignal.any([owner.signal, forwardSignal])
            deliverySignal.throwIfAborted()
            const coding = releaseCoding
            const compressed = coding === undefined
              ? undefined : await this.encodeReleaseCandidate(candidate, coding, deliverySignal, releasePrewarmed)
            const useEncoded = compressed !== undefined
            const body = useEncoded ? compressed : candidate.body
            deliverySignal.throwIfAborted()
            const current = await qualify()
            const expiresAt = Math.min(current.expiresAt, admission.expiresAt)
            if (current.user.id !== admission.user.id || current.placement.target !== placement.target || current.placement.local
              || current.placement.environment.node.id !== placement.environment.node.id
              || current.snapshot.generation !== snapshot.generation || current.snapshot.launchStamp !== snapshot.launchStamp
              || current.snapshot.startedAt !== snapshot.startedAt || current.snapshot.port !== snapshot.port
              || current.accessRevision !== admission.accessRevision || expiresAt <= Date.now()
              || !await synchronizeTo(BigInt(current.accessRevision))) {
              throw new RuntimeAssetUnavailableError(409, 'runtime-asset/authority-changed')
            }
            deliverySignal.throwIfAborted()
            if (expiresAt <= Date.now()) {
              throw new RuntimeAssetUnavailableError(409, 'runtime-asset/authority-changed')
            }
            res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': body.byteLength,
              'cache-control': BROWSER_RUNTIME_ASSET_CACHE_CONTROL, vary: 'accept-encoding',
              [NODE_SERVICE_TARGET_HEADER]: placement.environment.node.id,
              ...(useEncoded ? { 'content-encoding': coding } : {}) })
            await pipeline(Readable.from([body]), res, { signal: deliverySignal })
          },
        }
        if (!await this.options.forward(req, res, admission.user, placement, snapshot.generation, { capture, release })) {
          throw new RuntimeAssetUnavailableError(503, 'runtime-asset/unavailable')
        }
        return true
      }
      if (retained === null) throw new RuntimeAssetUnavailableError(503, 'runtime-asset/unavailable')
      const assertion = this.options.signer.issueAsset({ user: admission.user, scope: admission.scope,
        runtime: { ...snapshot.target, generation: snapshot.generation }, method: req.method as 'GET' | 'HEAD', path }, admission.expiresAt)
      await this.forwardLocal(req, res, snapshot.port, path, assertion, owner.signal,
        entryNodeId !== undefined && expectedNode !== undefined ? snapshot.generation : undefined)
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

  private async forwardLocal(req: IncomingMessage, res: ServerResponse, port: number, path: string, assertion: string,
    signal: AbortSignal, forwardedGeneration?: number): Promise<void> {
    const headers: Record<string, string> = {
      host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'x-dsh-gateway-principal': assertion,
    }
    for (const name of ['accept', 'accept-encoding', 'if-none-match', 'if-modified-since', 'range', 'if-range']) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    const challenge = req.headers[RELEASE_COMBO_DIGEST_HEADER]
    if (forwardedGeneration !== undefined && req.method === 'GET' && path.startsWith('/plugins/combo.js??')
      && typeof challenge === 'string' && /^[0-9a-f]{64}$/u.test(challenge)) headers[RELEASE_COMBO_DIGEST_HEADER] = challenge
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
      delete response.headers['x-dsh-operation-id']
      delete response.headers[NODE_SERVICE_TARGET_HEADER]
      for (const name of httpConnectionFields(response.headers.connection)) delete response.headers[name]
      delete response.headers[NODE_SERVICE_ASSET_GENERATION_HEADER]
      if (!Object.hasOwn(headers, RELEASE_COMBO_DIGEST_HEADER)) delete response.headers[RELEASE_COMBO_DIGEST_HEADER]
      if (forwardedGeneration === undefined) response.headers['cache-control'] = BROWSER_RUNTIME_ASSET_CACHE_CONTROL
      else response.headers[NODE_SERVICE_ASSET_GENERATION_HEADER] = String(forwardedGeneration)
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

  /**
   * Refuse new reads and cancel owned responses.
   * @returns shared completion of reference release and in-flight release compression.
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    let resolve!: () => void
    let reject!: (error: unknown) => void
    this.closing = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    void this.finishClose().then(resolve, reject)
    return this.closing
  }

  private async finishClose(): Promise<void> {
    this.unsubscribe()
    this.remoteCache.clear()
    this.remoteCacheBytes = 0
    this.releaseEncodedCache.clear()
    this.releaseEncodedBytes = 0
    for (const operation of this.active) operation.cancel()
    await Promise.allSettled([...this.work, ...this.releaseEncodingInFlight.values()])
  }
}
