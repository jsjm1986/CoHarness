/** VNC/RFB provider for `ctx.remoteDesktop`: a JSONL-backed grant store,
 * enforced `resolve → attach → serveStream` attachment flow, and an RFB pump
 * that drops input frames on view-only attachments. Endpoints are configured
 * per target; the dial is a protected seam for transports and tests.
 * @module @deepseek-ai/dsh-remote-desktop-vnc
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { randomBytes, randomUUID } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { createWriteStream, type WriteStream } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import {
  levelRank,
  RemoteDesktop,
  RemoteDesktopError,
  RemoteDesktopGrantId,
  RemoteDesktopSessionId,
  RemoteDesktopToken,
} from '@deepseek-ai/dsh-remote-desktop'
import type {
  RemoteDesktopActor,
  RemoteDesktopAttachRequest,
  RemoteDesktopAuditEvent,
  RemoteDesktopGrant,
  RemoteDesktopGrantFilter,
  RemoteDesktopGrantInput,
  RemoteDesktopLevel,
  RemoteDesktopSession,
  RemoteDesktopSpec,
  RemoteDesktopTarget,
  RemoteDesktopTargetStatus,
} from '@deepseek-ai/dsh-remote-desktop'
import { pumpRfb, type RfbPump } from './bridge.ts'
import { managedHandshake } from './managed.ts'
import { matchingGrants, VncGrantStore } from './grants.ts'
import { VncAuditLog } from './audit.ts'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'

/** Configuration for the VNC remote-desktop provider. */
export interface Config {
  /**
   * VNC endpoints per target (`nodeId` plus optional `desktop`). Duplicate
   * target keys fail at load.
   */
  endpoints?: {
    /** Node identifier this endpoint serves; matches `RemoteDesktopTarget.nodeId`. */
    nodeId: string
    /** Desktop name on the node; omit when the node exposes a single desktop. */
    desktop?: string
    /** VNC server hostname or address the RFB client dials. */
    host: string
    /** VNC server TCP port (RFB; conventionally 5900 + display number). */
    port: number
    /**
     * Login user name for password-authenticated servers (Apple Remote
     * Desktop type 30 requires it); meaningless without `passwordRef`.
     */
    username?: string
    /**
     * Credential reference — an environment-variable name — resolving to the
     * endpoint's password through `ctx.credentials`. When set, the provider
     * terminates the RFB security negotiation host-side and the browser
     * handshake offers only `None`: the password never leaves the host.
     */
    passwordRef?: string
  }[]
  /**
   * JSON file `{endpoints: [...]}` maintained by the deployment's
   * administration surface; when set it replaces the inline list and is
   * reloaded when the file changes.
   */
  endpointsFile?: string
  /** JSONL grant-store file; `':memory:'` selects a volatile store. */
  grantsFile?: string
  /**
   * Directory for `.rfb` recordings of grants flagged `recording`; empty
   * disables recording and a flagged attach fails at stream time.
   */
  recordingDir?: string
  /** WebSocket pathname the stream mount serves; clients append `?token=`. */
  streamPath?: string
  /** Milliseconds an attach token stays valid before the client connects. */
  attachTokenTtlMs?: number
  /** Append-only JSONL audit file; `':memory:'` selects a volatile window. */
  auditFile?: string
  /** In-memory audit events retained for `audit()` queries. */
  auditCapacity?: number
  /** Milliseconds `status` allows for the endpoint reachability probe. */
  probeTimeoutMs?: number
}

type ResolvedConfig = Required<Config>

interface PendingAttach {
  readonly sessionId: RemoteDesktopSessionId
  readonly spec: RemoteDesktopSpec
  readonly principal: string
  readonly expiresAt: number
  /** Self-expiry: an unconsumed token detaches its session so `live` stays accurate. */
  readonly timer: NodeJS.Timeout
}

interface LiveSession {
  readonly id: RemoteDesktopSessionId
  readonly session: RemoteDesktopSession
  readonly spec: RemoteDesktopSpec
  readonly principal: string
  /** The caller's Session address; re-matches session-scoped grants on mutations. */
  readonly sessionId?: SessionId
  pump?: RfbPump
}

/** One recorded consent: covers `grants` for `principal` on `targetKey` at `level`. */
interface ConsentRecord {
  readonly principal: string
  readonly targetKey: string
  readonly level: RemoteDesktopLevel
  readonly grants: ReadonlySet<RemoteDesktopGrantId>
  readonly at: number
}

function endpointKey(target: RemoteDesktopTarget): string {
  return JSON.stringify([target.nodeId, target.desktop ?? ''])
}

/** One configured VNC endpoint plus its optional managed-credential binding. */
interface VncEndpoint {
  readonly host: string
  readonly port: number
  readonly username?: string
  readonly passwordRef?: string
}

/**
 * Validate one endpoint row's credential fields and normalize the map value.
 * `username` without `passwordRef` configures nothing and fails loud;
 * `passwordRef` alone is valid — None-capable servers ignore it and ARD
 * selection fails at stream time when a username is required.
 */
function endpointRow(
  row: { host: string; port: number; username?: string; passwordRef?: string },
  label: string,
): VncEndpoint {
  if (row.passwordRef !== undefined && !isCredentialRefName(row.passwordRef)) {
    throw new RemoteDesktopError(`${label} carries an invalid passwordRef "${row.passwordRef}"`, 'REMOTE_DESKTOP_TRANSPORT')
  }
  if (row.username !== undefined && row.passwordRef === undefined) {
    throw new RemoteDesktopError(`${label} configures username without passwordRef`, 'REMOTE_DESKTOP_TRANSPORT')
  }
  return {
    host: row.host,
    port: row.port,
    ...(row.username === undefined ? {} : { username: row.username }),
    ...(row.passwordRef === undefined ? {} : { passwordRef: row.passwordRef }),
  }
}

/** Bound on tokens minted but not yet consumed by a stream handshake. */
const MAX_PENDING_ATTACHMENTS = 1024

/**
 * VNC/RFB implementation of {@link RemoteDesktop}. Grant administration and
 * attach resolution live here; stream transport reaches it through
 * `serveStream`. A `view` attachment pumps through `RfbClientFilter`, so
 * input frames are dropped inside the provider regardless of client UI.
 */
export class VncRemoteDesktop extends RemoteDesktop {
  static Config: z<Config> = z.object({
    endpoints: z.array(z.object({
      nodeId: z.string(),
      desktop: z.string().required(false),
      host: z.string(),
      port: z.number().step(1).min(1).max(65_535),
      username: z.string().required(false),
      passwordRef: z.string().required(false),
    })).default([]),
    /** JSON file `{endpoints: [...]}` maintained by the deployment's
     * administration surface; when set it replaces the inline list and is
     * reloaded on change. */
    endpointsFile: z.string().default(''),
    grantsFile: z.string().default(':memory:'),
    recordingDir: z.string().default(''),
    streamPath: z.string().default('/api/remote-desktop/stream'),
    attachTokenTtlMs: z.number().step(1).min(1).default(60_000),
    auditFile: z.string().default(':memory:'),
    auditCapacity: z.number().step(1).min(1).default(1024),
    probeTimeoutMs: z.number().step(1).min(1).default(3_000),
  })

  private readonly endpoints = new Map<string, VncEndpoint>()
  private endpointsMtimeMs = 0
  private readonly pending = new Map<RemoteDesktopToken, PendingAttach>()
  private readonly live = new Map<RemoteDesktopSessionId, LiveSession>()
  private consents: ConsentRecord[] = []
  private auditLog!: VncAuditLog
  private store!: VncGrantStore
  private readonly ready: Promise<void>

  constructor(ctx: Context, private readonly config: ResolvedConfig) {
    super(ctx)
    for (const endpoint of config.endpoints) {
      const key = endpointKey(endpoint)
      if (this.endpoints.has(key)) {
        throw new RemoteDesktopError(`duplicate remote-desktop endpoint for "${key}"`, 'REMOTE_DESKTOP_TRANSPORT')
      }
      this.endpoints.set(key, endpointRow(endpoint, `endpoint "${key}"`))
    }
    this.ready = this.init()
    ctx.effect(() => () => {
      for (const session of this.live.values()) session.pump?.close()
      for (const entry of this.pending.values()) clearTimeout(entry.timer)
      this.pending.clear()
    })
  }

  private async init(): Promise<void> {
    this.store = await VncGrantStore.open(this.config.grantsFile)
    this.auditLog = await VncAuditLog.open(this.config.auditFile, this.config.auditCapacity, this.ctx.logger)
    if (this.config.endpointsFile !== '') {
      this.endpoints.clear()
      await this.syncEndpoints()
    }
  }

  /**
   * Re-read `endpointsFile` when its mtime advanced; a missing or empty file
   * means no endpoints. A failed read keeps the last good map and leaves the
   * mtime unconsumed so every call retries until the file parses.
   */
  private async syncEndpoints(): Promise<void> {
    const file = this.config.endpointsFile
    if (file === '') return
    const info = await stat(file).catch(() => undefined)
    const mtimeMs = info?.mtimeMs ?? -1
    if (mtimeMs === this.endpointsMtimeMs) return
    const text = info === undefined
      ? ''
      : await readFile(file, 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
        throw error
      })
    if (text.trim() === '') {
      this.endpoints.clear()
      this.endpointsMtimeMs = mtimeMs
      return
    }
    const parsed = parseEndpointsFile(text, file)
    this.endpoints.clear()
    for (const [key, endpoint] of parsed) this.endpoints.set(key, endpoint)
    this.endpointsMtimeMs = mtimeMs
  }

  override async resolve(request: RemoteDesktopAttachRequest): Promise<RemoteDesktopSpec> {
    await this.ready
    await this.store.refresh()
    const grants = matchingGrants(this.store.all(), request.principal, request.target, request.sessionId, Date.now())
    if (grants.length === 0) {
      throw new RemoteDesktopError(
        `no remote-desktop grant for principal "${request.principal}" on "${endpointKey(request.target)}"`,
        'REMOTE_DESKTOP_FORBIDDEN',
      )
    }
    const granted = Math.max(...grants.map(g => levelRank(g.level)))
    if (levelRank(request.level) > granted) {
      throw new RemoteDesktopError(
        `grant level does not authorize "${request.level}" access`,
        'REMOTE_DESKTOP_FORBIDDEN',
      )
    }
    return {
      target: request.target,
      level: request.level,
      grants,
      recording: grants.some(g => g.recording),
    }
  }

  override async confirm(request: RemoteDesktopAttachRequest): Promise<RemoteDesktopSpec> {
    const spec = await this.resolve(request)
    const consent: ConsentRecord = {
      principal: request.principal,
      targetKey: endpointKey(spec.target),
      level: spec.level,
      grants: new Set(spec.grants.map(g => g.id)),
      at: Date.now(),
    }
    this.consents = this.consents.filter(c =>
      !(c.principal === consent.principal && c.targetKey === consent.targetKey && c.level === consent.level))
    this.consents.push(consent)
    this.record({
      kind: 'consent',
      principal: request.principal,
      target: spec.target,
      level: spec.level,
      grants: spec.grants.map(g => g.id),
      at: consent.at,
    })
    return spec
  }

  override async attach(request: RemoteDesktopAttachRequest): Promise<RemoteDesktopSession> {
    const spec = await this.resolve(request)
    this.requireConsent(spec, request.principal)
    const id = RemoteDesktopSessionId(randomUUID())
    const token = RemoteDesktopToken(randomBytes(32).toString('base64url'))
    if (this.pending.size >= MAX_PENDING_ATTACHMENTS) {
      throw new RemoteDesktopError('too many pending remote-desktop attachments', 'REMOTE_DESKTOP_TRANSPORT')
    }
    const timer = setTimeout(() => { this.expirePending(token) }, this.config.attachTokenTtlMs)
    timer.unref()
    this.pending.set(token, {
      sessionId: id,
      spec,
      principal: request.principal,
      expiresAt: Date.now() + this.config.attachTokenTtlMs,
      timer,
    })
    const session: RemoteDesktopSession = {
      id,
      spec,
      stream: { path: this.config.streamPath, token },
      detach: () => {
        this.dropPending(token)
        this.finishDetach(id)
        return Promise.resolve()
      },
    }
    this.live.set(id, {
      id, session, spec, principal: request.principal,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    })
    this.record({ kind: 'attach', session: id, spec, principal: request.principal, at: Date.now() })
    this.ctx.emit('remote-desktop/attached', session, true)
    return session
  }

  override async serveStream(token: RemoteDesktopToken, socket: Duplex): Promise<void> {
    await this.ready
    await this.syncEndpoints()
    const entry = this.pending.get(token)
    this.dropPending(token)
    if (!entry || entry.expiresAt <= Date.now()) {
      socket.destroy()
      if (entry !== undefined) this.finishDetach(entry.sessionId)
      throw new RemoteDesktopError('invalid or expired remote-desktop attach token', 'REMOTE_DESKTOP_FORBIDDEN')
    }
    const endpoint = this.endpoints.get(endpointKey(entry.spec.target))
    if (!endpoint) {
      socket.destroy()
      this.finishDetach(entry.sessionId)
      throw new RemoteDesktopError(
        `no VNC endpoint for "${endpointKey(entry.spec.target)}"`,
        'REMOTE_DESKTOP_TARGET_UNAVAILABLE',
      )
    }
    let upstream: Duplex
    try {
      upstream = await this.dial(endpoint)
    } catch (error) {
      socket.destroy()
      this.finishDetach(entry.sessionId)
      throw new RemoteDesktopError(
        `cannot reach VNC endpoint for "${endpointKey(entry.spec.target)}": ${(error as Error).message}`,
        'REMOTE_DESKTOP_TARGET_UNAVAILABLE',
      )
    }
    const session = this.live.get(entry.sessionId)
    if (!session) {
      upstream.destroy()
      socket.destroy()
      return
    }
    let recorder: WriteStream | undefined
    try {
      recorder = await this.openRecorder(entry)
    } catch (error) {
      upstream.destroy()
      socket.destroy()
      this.finishDetach(entry.sessionId)
      throw error
    }
    if (!this.live.has(entry.sessionId)) {
      recorder?.end()
      upstream.destroy()
      socket.destroy()
      return
    }
    if (recorder) upstream.on('data', (chunk: Buffer) => recorder.write(chunk))
    let residuals: { client?: Buffer; upstream?: Buffer } = {}
    const passwordRef = endpoint.passwordRef
    if (passwordRef !== undefined) {
      try {
        residuals = await this.managedStreamHandshake(socket, upstream, { username: endpoint.username, passwordRef })
      } catch (error) {
        recorder?.end()
        upstream.destroy()
        socket.destroy()
        this.finishDetach(entry.sessionId)
        throw error
      }
    }
    if (residuals.upstream !== undefined && residuals.upstream.length > 0) socket.write(residuals.upstream)
    const pump = pumpRfb(socket, upstream, entry.spec.level, {
      ...(passwordRef === undefined ? {} : { frameOnly: true }),
      ...(residuals.client === undefined ? {} : { clientResidual: residuals.client }),
    })
    session.pump = pump
    try {
      await pump.done
    } finally {
      recorder?.end()
      if (this.live.has(entry.sessionId)) this.finishDetach(entry.sessionId)
    }
  }

  /**
   * The credential-managed leg of {@link serveStream}: resolve the endpoint's
   * `passwordRef` per stream through `ctx.credentials`, then authenticate
   * host-side so the browser's handshake negotiates `None` and the password
   * never crosses to the client. Fails loud when the endpoint declares
   * `passwordRef` but no credentials provider is mounted or the reference
   * resolves to nothing — a managed endpoint must not silently degrade to the
   * interactive prompt the browser cannot answer anyway.
   */
  private async managedStreamHandshake(
    socket: Duplex,
    upstream: Duplex,
    endpoint: { username?: string | undefined; passwordRef: string },
  ): Promise<{ client: Buffer; upstream: Buffer }> {
    const credentials: CredentialProvider | undefined = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new RemoteDesktopError('endpoint declares passwordRef but no credentials provider is mounted', 'REMOTE_DESKTOP_TRANSPORT')
    }
    const resolved = await credentials.resolve(credentialRef(endpoint.passwordRef))
    if (resolved === undefined) {
      throw new RemoteDesktopError(`endpoint credential "${endpoint.passwordRef}" resolves to nothing`, 'REMOTE_DESKTOP_TRANSPORT')
    }
    const handshake = await managedHandshake(socket, upstream, {
      ...(endpoint.username === undefined ? {} : { username: endpoint.username }),
      password: resolved.value,
    })
    return { client: handshake.clientResidual, upstream: handshake.upstreamResidual }
  }

  override async status(
    actor: RemoteDesktopActor,
    target: RemoteDesktopTarget,
    options?: { sessionId?: SessionId },
  ): Promise<RemoteDesktopTargetStatus> {
    await this.ready
    await this.store.refresh()
    await this.syncEndpoints()
    const grants = matchingGrants(this.store.all(), actor.principal, target, options?.sessionId, Date.now())
    if (grants.length === 0) {
      throw new RemoteDesktopError(
        `no remote-desktop grant for principal "${actor.principal}" on "${endpointKey(target)}"`,
        'REMOTE_DESKTOP_FORBIDDEN',
      )
    }
    const endpoint = this.endpoints.get(endpointKey(target))
    let available = false
    if (endpoint) {
      try {
        const probe = await this.dial(endpoint, this.config.probeTimeoutMs)
        probe.destroy()
        available = true
      } catch {
        available = false
      }
    }
    const attachments = [...this.live.values()].filter(
      s => endpointKey(s.spec.target) === endpointKey(target),
    ).length
    const level: RemoteDesktopLevel = grants.some(g => g.level === 'control') ? 'control' : 'view'
    return {
      target,
      available,
      attachments,
      level,
      recording: grants.some(g => g.recording),
      consented: this.consentCovers(actor.principal, endpointKey(target), level, grants),
    }
  }

  override async listGrants(actor: RemoteDesktopActor, filter?: RemoteDesktopGrantFilter): Promise<RemoteDesktopGrant[]> {
    await this.ready
    await this.store.refresh()
    const principal = actor.admin ? filter?.principal : actor.principal
    const rows = this.store.all().filter(g =>
      (principal === undefined || g.principal === principal)
      && (filter?.includeRevoked || g.revokedAt === undefined)
      && (filter?.target === undefined
        || (g.target.nodeId === filter.target.nodeId && (g.target.desktop ?? '') === (filter.target.desktop ?? ''))))
    if (filter?.attachable !== true) return rows
    await this.syncEndpoints()
    const now = Date.now()
    return rows.filter(g =>
      this.endpoints.has(endpointKey(g.target))
      && matchingGrants([g], actor.principal, g.target, filter.sessionId, now).length > 0)
  }

  override async grant(input: RemoteDesktopGrantInput, actor: RemoteDesktopActor): Promise<RemoteDesktopGrant> {
    await this.ready
    await this.store.refresh()
    this.requireAdmin(actor)
    const grant: RemoteDesktopGrant = { ...input, id: RemoteDesktopGrantId(randomUUID()), createdAt: Date.now() }
    await this.store.insert(grant)
    this.record({ kind: 'grant', grant, actor, at: Date.now() })
    this.ctx.emit('remote-desktop/grants-changed')
    return grant
  }

  override async setLevel(id: RemoteDesktopGrantId, level: RemoteDesktopLevel, actor: RemoteDesktopActor): Promise<RemoteDesktopGrant> {
    await this.ready
    await this.store.refresh()
    this.requireAdmin(actor)
    const updated = await this.store.update(id, { level })
    this.record({ kind: 'set-level', grant: updated, actor, at: Date.now() })
    for (const session of this.live.values()) {
      if (session.spec.grants.some(g => g.id === id) && levelRank(level) > levelRank(session.spec.level)) {
        this.record({ kind: 'level-escalate', session: session.id, from: session.spec.level, to: level, principal: session.principal, at: Date.now() })
      }
    }
    this.enforceLiveSessions()
    this.ctx.emit('remote-desktop/grants-changed')
    return updated
  }

  override async revoke(id: RemoteDesktopGrantId, actor: RemoteDesktopActor): Promise<RemoteDesktopGrant> {
    await this.ready
    await this.store.refresh()
    this.requireAdmin(actor)
    const updated = await this.store.update(id, { revokedAt: Date.now() })
    this.record({ kind: 'revoke', grant: updated, actor, at: Date.now() })
    this.enforceLiveSessions()
    this.ctx.emit('remote-desktop/grants-changed')
    return updated
  }

  override async audit(
    actor: RemoteDesktopActor,
    filter?: { target?: RemoteDesktopTarget; principal?: string },
  ): Promise<RemoteDesktopAuditEvent[]> {
    await this.ready
    const principal = actor.admin ? filter?.principal : actor.principal
    return this.auditLog.all().filter((event) => {
      const touched = eventPrincipal(event)
      if (principal !== undefined && touched !== principal) return false
      const target = eventTarget(event)
      return filter?.target === undefined
        || (target !== undefined && target.nodeId === filter.target.nodeId && (target.desktop ?? '') === (filter.target.desktop ?? ''))
    }).reverse()
  }

  private consentCovers(
    principal: string,
    targetKey: string,
    level: RemoteDesktopLevel,
    grants: readonly RemoteDesktopGrant[],
  ): boolean {
    return this.consents.some(c =>
      c.principal === principal
      && c.targetKey === targetKey
      && levelRank(c.level) >= levelRank(level)
      && grants.every(g => c.grants.has(g.id)))
  }

  private requireConsent(spec: RemoteDesktopSpec, principal: string): void {
    if (!this.consentCovers(principal, endpointKey(spec.target), spec.level, spec.grants)) {
      throw new RemoteDesktopError(
        `remote-desktop attach for principal "${principal}" requires an explicit confirm first`,
        'REMOTE_DESKTOP_CONSENT_REQUIRED',
      )
    }
  }

  private requireAdmin(actor: RemoteDesktopActor): void {
    if (!actor.admin) {
      throw new RemoteDesktopError(`principal "${actor.principal}" is not a remote-desktop administrator`, 'REMOTE_DESKTOP_FORBIDDEN')
    }
  }

  private finishDetach(id: RemoteDesktopSessionId): void {
    const session = this.live.get(id)
    if (!session) return
    this.live.delete(id)
    session.pump?.close()
    this.record({ kind: 'detach', session: id, spec: session.spec, principal: session.principal, at: Date.now() })
    this.ctx.emit('remote-desktop/attached', session.session, false)
  }

  private record(event: RemoteDesktopAuditEvent): void {
    this.auditLog.record(event)
  }

  /**
   * Detach every live session whose spec level the remaining grants no longer
   * authorize for its principal and Session address. Runs after grant
   * mutations so revoke and downgrade take effect on open streams.
   */
  private enforceLiveSessions(): void {
    const grants = this.store.all()
    const now = Date.now()
    for (const session of [...this.live.values()]) {
      const remaining = matchingGrants(grants, session.principal, session.spec.target, session.sessionId, now)
      const authorized = remaining.length === 0 ? -1 : Math.max(...remaining.map(g => levelRank(g.level)))
      if (levelRank(session.spec.level) > authorized) this.finishDetach(session.id)
    }
  }

  private dropPending(token: RemoteDesktopToken): void {
    const entry = this.pending.get(token)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    this.pending.delete(token)
  }

  private expirePending(token: RemoteDesktopToken): void {
    const entry = this.pending.get(token)
    if (entry === undefined) return
    this.dropPending(token)
    this.finishDetach(entry.sessionId)
  }

  private async openRecorder(entry: PendingAttach): Promise<WriteStream | undefined> {
    if (!entry.spec.recording) return undefined
    if (this.config.recordingDir === '') {
      throw new RemoteDesktopError('grant requires recording but no recordingDir is configured', 'REMOTE_DESKTOP_TRANSPORT')
    }
    await mkdir(this.config.recordingDir, { recursive: true })
    return createWriteStream(join(this.config.recordingDir, `${entry.sessionId}.rfb`))
  }

  /**
   * Dial a VNC endpoint; the TCP seam providers and tests replace.
   * @param endpoint - the resolved host/port pair.
   * @param timeoutMs - optional connect timeout; the socket fails on expiry.
   */
  protected dial(endpoint: { host: string; port: number }, timeoutMs?: number): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const socket = connect(endpoint.port, endpoint.host)
      const fail = (error: Error): void => {
        socket.destroy()
        reject(error)
      }
      socket.once('connect', () => {
        socket.removeListener('error', fail)
        if (timeoutMs !== undefined) socket.setTimeout(0)
        resolve(socket)
      })
      socket.once('error', fail)
      if (timeoutMs !== undefined) {
        socket.setTimeout(timeoutMs, () => { fail(new RemoteDesktopError('VNC endpoint probe timed out', 'REMOTE_DESKTOP_TARGET_UNAVAILABLE')) })
      }
    })
  }
}

/**
 * Parse `endpointsFile` content into a validated key→endpoint map. Malformed
 * JSON, a non-array `endpoints`, a wrong-shaped row, and duplicate keys all
 * fail with `REMOTE_DESKTOP_TRANSPORT` naming the file.
 */
function parseEndpointsFile(text: string, file: string): Map<string, VncEndpoint> {
  const fail = (detail: string): never => {
    throw new RemoteDesktopError(`invalid remote-desktop endpoints file "${file}": ${detail}`, 'REMOTE_DESKTOP_TRANSPORT')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return fail('not valid JSON')
  }
  const rows = (parsed as { endpoints?: unknown }).endpoints
  if (!Array.isArray(rows)) return fail('"endpoints" must be an array')
  const next = new Map<string, VncEndpoint>()
  for (const [index, row] of rows.entries()) {
    if (typeof row !== 'object' || row === null) {
      return fail(`row ${index} must carry string nodeId, optional desktop, string host, and integer port 1-65535`)
    }
    const endpoint = row as {
      nodeId?: unknown
      desktop?: unknown
      host?: unknown
      port?: unknown
      username?: unknown
      passwordRef?: unknown
    }
    if (typeof endpoint.nodeId !== 'string'
      || (endpoint.desktop !== undefined && typeof endpoint.desktop !== 'string')
      || typeof endpoint.host !== 'string'
      || typeof endpoint.port !== 'number' || !Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535
      || (endpoint.username !== undefined && typeof endpoint.username !== 'string')
      || (endpoint.passwordRef !== undefined && typeof endpoint.passwordRef !== 'string')) {
      return fail(`row ${index} must carry string nodeId, optional desktop, string host, integer port 1-65535, and optional string username/passwordRef`)
    }
    const key = endpointKey({ nodeId: endpoint.nodeId, ...(endpoint.desktop === undefined ? {} : { desktop: endpoint.desktop }) })
    if (next.has(key)) return fail(`duplicate endpoint for "${key}"`)
    let value: VncEndpoint
    try {
      value = endpointRow(
        {
          host: endpoint.host, port: endpoint.port,
          ...(endpoint.username === undefined ? {} : { username: endpoint.username }),
          ...(endpoint.passwordRef === undefined ? {} : { passwordRef: endpoint.passwordRef }),
        },
        `row ${index}`,
      )
    } catch (error) {
      return fail((error as Error).message)
    }
    next.set(key, value)
  }
  return next
}

function eventPrincipal(event: RemoteDesktopAuditEvent): string {
  switch (event.kind) {
    case 'grant': case 'revoke': case 'set-level': return event.actor.principal
    case 'consent': case 'attach': case 'detach': case 'level-escalate': return event.principal
    default: return assertNever(event)
  }
}

function eventTarget(event: RemoteDesktopAuditEvent): RemoteDesktopTarget | undefined {
  switch (event.kind) {
    case 'consent': return event.target
    case 'grant': case 'revoke': case 'set-level': return event.grant.target
    case 'attach': case 'detach': return event.spec.target
    case 'level-escalate': return undefined
    default: return assertNever(event)
  }
}

export default VncRemoteDesktop
