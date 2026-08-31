import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'
import type { UserRow } from './auth.ts'
import {
  AccountPreferencesConflictError,
  AccountPreferencesInputError,
  normalizeAccountPreferenceMutation,
} from './account-preferences.ts'
import { CollaborationDeniedError } from './collaboration.ts'
import type { GatewayConfig } from './config.ts'
import type { ProjectRuntime } from './instances.ts'
import type { PrincipalScope } from './principal.ts'
import type { GatewayPushService, PushProvider } from './push-notifications.ts'
import { loginPage, passwordPage } from './html.ts'
import {
  DOCUMENT_TRANSFER_UPLOADS_PATH,
  DOCUMENT_SCOPE_PATH,
  DocumentTransferError,
  parseDocumentScopeKey,
  type GatewayDocumentScopeHandler,
  type GatewayDocumentAdminHandler,
  type GatewayDocumentTransferListHandler,
  type GatewayDocumentTransferUploadHandler,
} from './document-transfer.ts'
import type {
  Awaitable,
  GatewayAuditService,
  GatewayAuthService,
  GatewayCollaborationService,
  GatewayDocumentCatalogService,
  GatewayInstanceService,
  GatewayModelGovernanceService,
  GatewayProjectService,
  GatewayUserService,
  GatewayUserPreferencesService,
} from './services.ts'
import type { ConversationArchiveService } from './postgres/conversation-archive-service.ts'
import { isAdminPath, serveAdmin } from './static.ts'
import { ResponseBodyTooLargeError } from './response-budget.ts'
import { removeBootstrapAdminPassword } from './bootstrap-admin.ts'
import type { ProjectConfigurationView } from './project-configuration.ts'
import type { ProjectThemePolicy } from './projects.ts'
import { applyModelGovernanceToProject, scheduleModelGovernanceRefresh } from './apply-model-governance.ts'
import { ProjectModelSettingsConflictError, type ModelSettingsPathOp } from './model-governance.ts'

export interface GatewayDeps {
  cfg: GatewayConfig
  auth: GatewayAuthService
  users: GatewayUserService
  projects: GatewayProjectService
  audit: GatewayAuditService
  instances: GatewayInstanceService
  governance?: GatewayModelGovernanceService
  collaboration?: GatewayCollaborationService
  /** PostgreSQL-backed account preferences; absent in legacy test compositions. */
  userPreferences?: GatewayUserPreferencesService
  /** Optional organization-level document metadata catalog. */
  documents?: GatewayDocumentCatalogService
  /** Optional organization-wide archived conversation index and lifecycle service. */
  archives?: ConversationArchiveService
  /** Optional persistent device registry and multi-provider push delivery service. */
  push?: GatewayPushService
  readiness?: (signal?: AbortSignal) => Awaitable<void>
}

export const SESSION_COOKIE = 'hgw_session'
export const SCOPE_COOKIE = 'hgw_scope'

export function parseCookies(header: string | undefined): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  return map
}

export function sessionCookie(token: string, cfg: GatewayConfig, clear = false): string {
  const maxAge = clear ? 0 : Math.floor(cfg.sessionTtlMs / 1000)
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
    + (cfg.secureCookies ? '; Secure' : '')
}

export function scopeCookie(scope: 'personal' | `project:${number}`, cfg: GatewayConfig): string {
  return `${SCOPE_COOKIE}=${scope}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(cfg.sessionAbsoluteTtlMs / 1000)}`
    + (cfg.secureCookies ? '; Secure' : '')
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? ''
}

function wantsHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('text/html')
}

class BodyTooLargeError extends Error {}

async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  const declared = req.headers['content-length']
  if (typeof declared === 'string') {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
      req.resume()
      throw new BodyTooLargeError('body too large')
    }
  }
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of req) {
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : (chunk as Buffer).byteLength
      size += bytes
      if (size > limit) {
        req.resume()
        throw new BodyTooLargeError('body too large')
      }
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer)
    }
  } catch (error) {
    req.resume()
    throw error
  }
  return Buffer.concat(chunks).toString()
}

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

function requestAbort(req: IncomingMessage, res: ServerResponse): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const onRequestAbort = (): void => { if (!controller.signal.aborted) controller.abort(new Error('document request aborted')) }
  const onResponseClose = (): void => { if (!res.writableEnded) onRequestAbort() }
  req.once('aborted', onRequestAbort)
  res.once('close', onResponseClose)
  return {
    signal: controller.signal,
    dispose: () => {
      req.removeListener('aborted', onRequestAbort)
      res.removeListener('close', onResponseClose)
    },
  }
}

/**
 * Wait for writable capacity or a closed response without leaving the losing
 * event listener behind.  A plain `Promise.race([once(...)])` retains one
 * listener for every backpressured response until the other event eventually
 * fires; long-lived downloads then trigger EventEmitter listener warnings.
 */
async function waitForResponseWritable(res: ServerResponse): Promise<'drain' | 'close'> {
  if (res.destroyed || res.writableEnded) return 'close'
  return new Promise<'drain' | 'close'>(resolve => {
    let settled = false
    const finish = (event: 'drain' | 'close'): void => {
      if (settled) return
      settled = true
      res.removeListener('drain', onDrain)
      res.removeListener('close', onClose)
      resolve(event)
    }
    const onDrain = (): void => { finish('drain') }
    const onClose = (): void => { finish('close') }
    res.once('drain', onDrain)
    res.once('close', onClose)
    // The response can close between the state check above and listener
    // installation. Re-check after registration so that waiters never wedge.
    if (res.destroyed || res.writableEnded) finish('close')
  })
}

async function sendGatewayResponse(res: ServerResponse, response: Response, limit: number): Promise<void> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
      await response.body?.cancel()
      send(res, 502, JSON.stringify({ error: { code: 'UPSTREAM_RESPONSE_TOO_LARGE', message: 'The runtime response is too large.' } }), 'application/json')
      return
    }
  }
  const headers: Record<string, string> = {
    'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
    'cache-control': response.headers.get('cache-control') ?? 'no-store',
  }
  for (const name of ['content-length', 'content-disposition', 'x-content-type-options', 'content-security-policy']) {
    const value = response.headers.get(name)
    if (value !== null) headers[name] = value
  }
  res.writeHead(response.status, headers)
  if (response.body === null) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  const cancelOnClose = (): void => { void reader.cancel().catch(() => {}) }
  res.once('close', cancelOnClose)
  try {
    let total = 0
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => {})
        if (!res.destroyed) res.destroy(new ResponseBodyTooLargeError(limit))
        return
      }
      if (!res.write(next.value) && await waitForResponseWritable(res) === 'close') break
      if (res.destroyed) break
    }
    if (!res.writableEnded) res.end()
  } catch (error) {
    if (!res.destroyed) res.destroy(error as Error)
  } finally {
    res.removeListener('close', cancelOnClose)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function isScopedUploadDataPath(method: string | undefined, pathname: string): boolean {
  return (method === 'PUT' && /\/chunks\/[0-9]+$/u.test(pathname))
    || (method === 'GET' && /^\/api\/documents\/transfer\/uploads\/[0-9a-f-]{36}$/u.test(pathname))
}

function scopedDocumentOperation(pathname: string, method: string | undefined): import('./document-transfer.ts').GatewayDocumentScopeOperation | undefined {
  if (pathname === DOCUMENT_SCOPE_PATH) {
    if (method === 'GET') return 'list'
    if (method === 'DELETE') return 'delete'
  }
  if (pathname === `${DOCUMENT_SCOPE_PATH}/directories` && method === 'GET') return 'directories'
  if (pathname === `${DOCUMENT_SCOPE_PATH}/content` && (method === 'GET' || method === 'HEAD')) return 'content'
  if (pathname === `${DOCUMENT_SCOPE_PATH}/trash` && (method === 'GET' || method === 'POST')) return 'trash'
  if (pathname === `${DOCUMENT_SCOPE_PATH}/restore` && method === 'POST') return 'restore'
  if (pathname === `${DOCUMENT_SCOPE_PATH}/purge` && method === 'DELETE') return 'purge'
  if (pathname === `${DOCUMENT_SCOPE_PATH}/folders` && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) return 'folders'
  if (pathname === `${DOCUMENT_SCOPE_PATH}/move` && method === 'POST') return 'move'
  return undefined
}

function sendAdminGate(res: ServerResponse, pathname: string, error: string): void {
  if (pathname.startsWith('/admin/api')) {
    send(res, 403, JSON.stringify({ error }), 'application/json')
    return
  }
  send(res, 403, error, 'text/plain')
}

function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  res.writeHead(302, { location, ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}) })
  res.end()
}

function csrfOk(req: IncomingMessage, cfg: GatewayConfig, pathname: string): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true
  const origin = req.headers.origin
  if (origin !== undefined) return cfg.publicOrigins.includes(origin)
  return pathname.startsWith('/api')
}

function jsonObject(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Decode path-addressed settings edits at the Gateway HTTP boundary. */
function projectSettingsOps(value: unknown): ModelSettingsPathOp[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const result: ModelSettingsPathOp[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const row = entry as Record<string, unknown>
    if (!Array.isArray(row.path) || row.path.some(segment => typeof segment !== 'string'
      || segment.length === 0 || segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) return undefined
    if (row.op === 'set' && Object.hasOwn(row, 'value')) {
      result.push({ op: 'set', path: row.path as string[], value: row.value })
    } else if (row.op === 'unset' && !Object.hasOwn(row, 'value')) {
      result.push({ op: 'unset', path: row.path as string[] })
    } else return undefined
  }
  return result
}

function accountProjectError(error: unknown): { status: number; error: string } {
  if (error instanceof BodyTooLargeError) {
    return { status: 413, error: 'request-too-large' }
  }
  if (error instanceof CollaborationDeniedError) {
    return { status: error.code === 'conversation-not-found' ? 404 : 403, error: error.code }
  }
  if (error instanceof Error) {
    const status = error.message === 'invitation-already-pending' || error.message === 'invitation-already-member'
      || error.message.startsWith('settings-conflict:') ? 409
      : error.message === 'invitation-not-found' || error.message === 'project-not-found' ? 404
        : error.message === 'invitation-forbidden' ? 403
          : error.message === 'invitation-expired' ? 410
            : error.message === 'invitation-not-pending' ? 409
              : error.message === 'owner-protected' || error.message === 'owner-must-be-rw' || error.message === 'user-disabled' ? 409
                : error.message.startsWith('duplicate ') ? 409
                  : error.message.startsWith('unknown project') ? 404 : 400
    return { status, error: error.message.startsWith('settings-conflict:') ? 'settings-conflict' : error.message }
  }
  return { status: 400, error: String(error) }
}

/** Project database writes remain successful while a file projection retries. */
async function applyProjectGovernanceBestEffort(
  deps: Pick<GatewayDeps, 'cfg' | 'governance' | 'projects' | 'users'>,
  projectId: number,
): Promise<void> {
  try {
    await applyModelGovernanceToProject(deps, projectId)
  } catch (error: unknown) {
    console.error('[gateway] project model policy projection deferred:', error)
    scheduleModelGovernanceRefresh(deps)
  }
}

export interface GatewayRequestContext {
  user: UserRow
  scope: PrincipalScope
  runtime: UserRow | ProjectRuntime
}

export type ProxyHandler = (req: IncomingMessage, res: ServerResponse, context: GatewayRequestContext) => Promise<void>
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, context: GatewayRequestContext) => Promise<void>

export interface GatewayHandlers {
  proxy?: ProxyHandler
  upgrade?: UpgradeHandler
  /** Gateway-owned alternate-scope document listing; never expose runtime URLs. */
  documentTransferList?: GatewayDocumentTransferListHandler
  /** Gateway-owned target-scope resumable upload proxy. */
  documentTransferUpload?: GatewayDocumentTransferUploadHandler
  /** Gateway-owned full document operations for an explicitly selected scope. */
  documentScope?: GatewayDocumentScopeHandler
  /** Gateway-owned administrator lifecycle operations for catalog rows. */
  documentAdmin?: GatewayDocumentAdminHandler
  admin?: (req: IncomingMessage, res: ServerResponse, user: UserRow, pathname: string, body: string) => Promise<boolean>
  /**
   * Authenticate a loopback runtime request before its body is read. The
   * production composition supplies the runtime-token verifier; keeping this
   * callback at the HTTP boundary prevents unauthenticated callers from
   * forcing a 64 MiB allocation before the runtime handler can reject them.
   */
  runtimeAuthorize?: (req: IncomingMessage) => Awaitable<boolean>
  runtime?: (req: IncomingMessage, res: ServerResponse, pathname: string, body: string) => Promise<boolean>
  /** Override `serveAdmin` root (tests); default `gateway/public/admin`. */
  adminRoot?: string
}

export function createGatewayServer(deps: GatewayDeps, handlers: GatewayHandlers = {}): Server {
  const { cfg, auth, users, audit } = deps

  const HEALTH_READINESS_TIMEOUT_MS = 5_000
  const HEALTH_READINESS_CACHE_MS = 1_000
  const HEALTH_READINESS_FAILURE_BACKOFF_MS = 1_000
  let readinessInFlight: Promise<void> | undefined
  let readinessCachedUntil = 0
  let readinessFailureUntil = 0
  let readinessFailure: Error | undefined

  /** Share a short readiness probe across concurrent health checks. */
  const checkReadiness = async (): Promise<void> => {
    if (deps.readiness === undefined) return
    const now = Date.now()
    if (readinessCachedUntil > now) return
    if (readinessFailure !== undefined && readinessFailureUntil > now) throw readinessFailure
    if (readinessInFlight !== undefined) return readinessInFlight
    const controller = new AbortController()
    const readinessTimeoutMs = Math.min(cfg.readinessTimeoutMs, HEALTH_READINESS_TIMEOUT_MS)
    const operation = Promise.resolve().then(() => deps.readiness?.(controller.signal))
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error('Gateway readiness probe timed out'))
        const error = new Error('Gateway readiness probe timed out')
        error.name = 'TimeoutError'
        reject(error)
      }, readinessTimeoutMs)
      timer.unref?.()
    })
    const probe = Promise.race([operation, timeout]).then(() => {
      readinessFailure = undefined
      readinessFailureUntil = 0
      readinessCachedUntil = Date.now() + HEALTH_READINESS_CACHE_MS
    }).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error))
      readinessFailure = failure
      readinessFailureUntil = Date.now() + HEALTH_READINESS_FAILURE_BACKOFF_MS
      throw failure
    }).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
      if (readinessInFlight === probe) readinessInFlight = undefined
    })
    readinessInFlight = probe
    return probe
  }

  const currentUser = async (req: IncomingMessage): Promise<{ token: string; user: UserRow } | null> => {
    const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
    if (token === undefined) return null
    const user = await auth.validate(token)
    return user === null ? null : { token, user }
  }

  const requestContext = async (req: IncomingMessage, user: UserRow): Promise<{
    context: GatewayRequestContext
    resetScope: boolean
  }> => {
    const raw = parseCookies(req.headers.cookie).get(SCOPE_COOKIE)
    const match = raw?.match(/^project:([1-9][0-9]*)$/)
    if (match === null || match === undefined || deps.collaboration === undefined) {
      return { context: { user, scope: { kind: 'personal' }, runtime: user }, resetScope: raw !== undefined && raw !== 'personal' }
    }
    const projectId = Number(match[1])
    if (!Number.isSafeInteger(projectId)) {
      return { context: { user, scope: { kind: 'personal' }, runtime: user }, resetScope: true }
    }
    const project = await deps.collaboration.projectForUser(projectId, user.id)
    if (project === null) {
      return { context: { user, scope: { kind: 'personal' }, runtime: user }, resetScope: true }
    }
    const detail = await deps.projects.getById(projectId)
    const canManage = user.role === 'admin' || project.administrator || detail?.owner?.id === user.id
    return {
      context: {
        user,
        scope: {
          kind: 'project', projectId, projectName: project.name, mode: project.mode, canManage,
          ...(detail?.uiThemePolicy === undefined ? {} : { uiThemePolicy: detail.uiThemePolicy }),
        },
        runtime: { kind: 'project', id: projectId, name: project.name, path: project.path },
      },
      resetScope: false,
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.writableEnded) {
        if (error instanceof BodyTooLargeError) {
          send(res, 413, JSON.stringify({ error: 'request-too-large' }), 'application/json')
        } else if ((req.url ?? '').startsWith('/internal/runtime/')) {
          // Runtime consumers require JSON even when an unexpected exception
          // escapes a route. Keep stack details in the server log only; paths,
          // SQL errors, and provider diagnostics are not browser copy.
          send(res, 500, JSON.stringify({
            error: 'runtime-internal',
            code: 'internal',
            message: 'The runtime could not complete this request.',
          }), 'application/json')
        } else {
          send(res, 500, 'internal error', 'text/plain')
        }
      }
      if (!(error instanceof BodyTooLargeError)) console.error('[gateway] request failed:', error)
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname

    if (pathname === '/healthz/live') {
      send(res, 200, JSON.stringify({ ok: true, release: cfg.releaseId }), 'application/json')
      return
    }

    if (pathname === '/healthz' || pathname === '/healthz/ready') {
      try {
        await checkReadiness()
        send(res, 200, JSON.stringify({ ok: true, release: cfg.releaseId }), 'application/json')
      } catch {
        send(res, 503, JSON.stringify({ ok: false, release: cfg.releaseId }), 'application/json')
      }
      return
    }

    if (pathname.startsWith('/internal/runtime/')) {
      if (handlers.runtimeAuthorize !== undefined) {
        let authorized = false
        try {
          authorized = await handlers.runtimeAuthorize(req)
        } catch {
          authorized = false
        }
        if (!authorized) {
          // Drain the request so keep-alive clients cannot strand the socket,
          // but never buffer the attacker-controlled body first.
          req.resume()
          send(res, 401, '{"error":"invalid-runtime-token"}', 'application/json')
          return
        }
      } else if (req.headers.authorization === undefined) {
        // Test/legacy compositions may omit a verifier callback. They still
        // receive the cheap header gate; production wires the callback above
        // for cryptographic validation before body admission.
        req.resume()
        send(res, 401, '{"error":"invalid-runtime-token"}', 'application/json')
        return
      }
      let body = ''
      try {
        body = req.method === 'GET' || req.method === 'HEAD'
          ? ''
          : await readBody(req, cfg.runtimeApiBodyLimitBytes)
      } catch (error: unknown) {
        if (!(error instanceof BodyTooLargeError)) throw error
        send(res, 413, '{"error":"runtime-request-too-large"}', 'application/json')
        return
      }
      if (handlers.runtime !== undefined && await handlers.runtime(req, res, pathname, body)) return
      send(res, 404, '{"error":"not-found"}', 'application/json')
      return
    }

    if (!csrfOk(req, cfg, pathname)) { sendAdminGate(res, pathname, 'origin not allowed'); return }

    if (pathname === '/login') {
      if (req.method === 'GET') { send(res, 200, loginPage()); return }
      if (req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req))
        const username = form.get('username') ?? ''
        const result = await auth.login(username, form.get('password') ?? '', clientIp(req), req.headers['user-agent'] ?? '')
        if (result === 'locked') { await audit.write({ action: 'login.locked', ip: clientIp(req), detail: username }); send(res, 429, loginPage('尝试过于频繁，请 10 分钟后再试')); return }
        if (result === 'invalid') { await audit.write({ action: 'login.failed', ip: clientIp(req), detail: username }); send(res, 401, loginPage('用户名或密码错误')); return }
        await audit.write({ userId: result.user.id, action: 'login', ip: clientIp(req) })
        redirect(res, '/', [sessionCookie(result.token, cfg)])
        return
      }
    }

    const session = await currentUser(req)
    if (session === null) {
      if (wantsHtml(req)) { redirect(res, '/login'); return }
      send(res, 401, '{"error":"unauthorized"}', 'application/json')
      return
    }
    const { token, user } = session

    if (pathname === '/logout' && req.method === 'POST') {
      await auth.revoke(token)
      await audit.write({ userId: user.id, action: 'logout', ip: clientIp(req) })
      redirect(res, '/login', [sessionCookie('', cfg, true)])
      return
    }

    if (user.mustChangePassword && pathname !== '/account/password') {
      if (wantsHtml(req)) { redirect(res, '/account/password'); return }
      send(res, 403, '{"error":"password-change-required"}', 'application/json')
      return
    }

    if (pathname === '/account/api/usage' && req.method === 'GET') {
      if (deps.governance === undefined) { send(res, 503, '{"error":"usage-unavailable"}', 'application/json'); return }
      const month = new URL(req.url ?? '/', 'http://x').searchParams.get('month') ?? undefined
      const resolvedUsage = await requestContext(req, user)
      if (resolvedUsage.resetScope) res.setHeader('set-cookie', scopeCookie('personal', cfg))
      const subject = resolvedUsage.context.scope.kind === 'project'
        ? { kind: 'project' as const, id: resolvedUsage.context.scope.projectId }
        : { kind: 'user' as const, id: user.id }
      send(res, 200, JSON.stringify(await deps.governance.summary(subject, month)), 'application/json')
      return
    }

    if (pathname === '/account/password') {
      if (req.method === 'GET') { send(res, 200, passwordPage()); return }
      if (req.method === 'POST') {
        const password = new URLSearchParams(await readBody(req)).get('password') ?? ''
        if (password.length < 8) { send(res, 400, passwordPage('密码至少 8 位')); return }
        await users.changeOwnPassword(user.id, password)
        await removeBootstrapAdminPassword(cfg.bootstrapAdminPasswordFile).catch((error: unknown) => {
          // Password change remains successful; operators can remove a stale
          // one-time file after the warning if the filesystem rejected it.
          console.error('[gateway] bootstrap password file cleanup failed:', error)
        })
        await audit.write({ userId: user.id, action: 'password.changed', ip: clientIp(req) })
        redirect(res, '/')
        return
      }
    }

    if (pathname === '/account/api/push-devices' && req.method === 'POST') {
      if (deps.push === undefined) {
        send(res, 503, '{"error":"push-unavailable"}', 'application/json')
        return
      }
      const input = jsonObject(await readBody(req))
      const token = stringField(input?.token)
      const platform = input?.platform
      const provider = input?.provider === undefined ? 'fcm' : input.provider
      const deviceId = input?.deviceId === undefined ? undefined : stringField(input.deviceId)
      const appVersion = input?.appVersion === undefined ? undefined : stringField(input.appVersion)
      if (token === undefined || token.length > 4096 || platform !== 'android'
        || (provider !== 'fcm' && provider !== 'jpush')
        || (input?.deviceId !== undefined && deviceId === undefined)
        || (input?.appVersion !== undefined && appVersion === undefined)) {
        send(res, 400, '{"error":"invalid-push-device"}', 'application/json')
        return
      }
      const device = await deps.push.registerDevice(user.id, {
        token,
        platform,
        provider: provider as PushProvider,
        ...(deviceId === undefined ? {} : { deviceId }),
        ...(appVersion === undefined ? {} : { appVersion }),
      })
      send(res, 201, JSON.stringify(device), 'application/json')
      return
    }

    const pushDeviceRoute = pathname.match(/^\/account\/api\/push-devices\/([^/]+)$/)
    if (pushDeviceRoute !== null && req.method === 'DELETE') {
      if (deps.push === undefined) {
        send(res, 503, '{"error":"push-unavailable"}', 'application/json')
        return
      }
      let deviceId: string
      try {
        deviceId = decodeURIComponent(pushDeviceRoute[1] ?? '')
      } catch {
        send(res, 400, '{"error":"invalid-push-device-id"}', 'application/json')
        return
      }
      if (deviceId === '') {
        send(res, 400, '{"error":"invalid-push-device-id"}', 'application/json')
        return
      }
      const removed = await deps.push.removeDevice(user.id, deviceId)
      if (!removed) {
        send(res, 404, '{"error":"push-device-not-found"}', 'application/json')
        return
      }
      res.writeHead(204)
      res.end()
      return
    }

    if (pathname === '/account/api/scope' && req.method === 'POST') {
      let requested: unknown
      try {
        requested = JSON.parse(await readBody(req))
      } catch {
        send(res, 400, '{"error":"invalid-json"}', 'application/json')
        return
      }
      if (typeof requested !== 'object' || requested === null || Array.isArray(requested)) {
        send(res, 400, '{"error":"invalid-scope"}', 'application/json')
        return
      }
      const value = requested as { kind?: unknown; projectId?: unknown }
      if (value.kind === 'personal') {
        await deps.instances.ensureRunning(user)
        res.writeHead(204, { 'set-cookie': scopeCookie('personal', cfg) })
        res.end()
        return
      }
      if (value.kind !== 'project' || typeof value.projectId !== 'number'
        || !Number.isSafeInteger(value.projectId) || value.projectId <= 0) {
        send(res, 400, '{"error":"invalid-scope"}', 'application/json')
        return
      }
      const project = await deps.collaboration?.projectForUser(value.projectId, user.id)
      if (project === undefined || project === null) {
        send(res, 403, '{"error":"not-member"}', 'application/json')
        return
      }
      await deps.instances.ensureRunning({
        kind: 'project',
        id: value.projectId,
        name: project.name,
        path: project.path,
      })
      res.writeHead(204, { 'set-cookie': scopeCookie(`project:${value.projectId}`, cfg) })
      res.end()
      return
    }

    const resolved = await requestContext(req, user)
    if (resolved.resetScope) res.setHeader('set-cookie', scopeCookie('personal', cfg))

    const scopedUploadRequest = pathname === DOCUMENT_TRANSFER_UPLOADS_PATH
      || pathname.startsWith(`${DOCUMENT_TRANSFER_UPLOADS_PATH}/`)
    if (scopedUploadRequest && handlers.documentTransferUpload !== undefined) {
      const requestUrl = new URL(req.url ?? '/', 'http://gateway')
      const isChunk = /\/chunks\/[0-9]+$/u.test(pathname)
      const isSession = /^\/api\/documents\/transfer\/uploads\/[0-9a-f-]{36}$/u.test(pathname)
      const isComplete = /\/complete$/u.test(pathname)
      const allowed = pathname === DOCUMENT_TRANSFER_UPLOADS_PATH
        ? req.method === 'POST'
        : isChunk
          ? req.method === 'PUT'
          : isComplete
            ? req.method === 'POST'
            : isSession && (req.method === 'GET' || req.method === 'DELETE')
      if (!allowed) {
        send(res, 405, JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } }), 'application/json')
        return
      }
      let scope
      try {
        scope = parseDocumentScopeKey(requestUrl.searchParams.get('scope'))
      } catch (error: unknown) {
        if (error instanceof DocumentTransferError) {
          send(res, error.status, JSON.stringify({ error: { code: error.code, message: error.message } }), 'application/json')
        } else {
          send(res, 400, JSON.stringify({ error: { code: 'INVALID_DOCUMENT_TRANSFER', message: 'Invalid document upload scope.' } }), 'application/json')
        }
        return
      }
      const abort = requestAbort(req, res)
      if (!isScopedUploadDataPath(req.method, pathname)) {
        res.once('finish', () => {
          void Promise.resolve(audit.write({
            userId: user.id,
            action: 'api',
            methodPath: `${req.method} ${pathname}`,
            status: res.statusCode,
            ip: clientIp(req),
          })).catch(error => { console.error('[gateway] API audit write failed:', error) })
        })
      }
      try {
        const response = await handlers.documentTransferUpload({
          user,
          request: req,
          pathname,
          scope,
          signal: abort.signal,
        })
        if (!abort.signal.aborted && !res.writableEnded) await sendGatewayResponse(res, response, cfg.upstreamResponseLimitBytes)
      } catch (error: unknown) {
        if (abort.signal.aborted || res.writableEnded) return
        if (error instanceof DocumentTransferError) {
          send(res, error.status, JSON.stringify({ error: { code: error.code, message: error.message } }), 'application/json')
          return
        }
        send(res, 503, JSON.stringify({ error: { code: 'DOCUMENT_TRANSFER_UNAVAILABLE', message: 'Target document runtime is unavailable.' } }), 'application/json')
      } finally {
        abort.dispose()
      }
      return
    }

    const scopedOperation = handlers.documentScope === undefined
      ? undefined
      : scopedDocumentOperation(pathname, req.method)
    if (scopedOperation !== undefined && handlers.documentScope !== undefined) {
      const requestUrl = new URL(req.url ?? '/', 'http://gateway')
      let scope: ReturnType<typeof parseDocumentScopeKey>
      try {
        scope = parseDocumentScopeKey(requestUrl.searchParams.get('scope'))
      } catch (error: unknown) {
        if (error instanceof DocumentTransferError) {
          send(res, error.status, JSON.stringify({ error: { code: error.code, message: error.message } }), 'application/json')
        } else {
          send(res, 400, JSON.stringify({ error: { code: 'INVALID_DOCUMENT_TRANSFER', message: 'Invalid document scope.' } }), 'application/json')
        }
        return
      }
      const abort = requestAbort(req, res)
      res.once('finish', () => {
        void Promise.resolve(audit.write({
          userId: user.id,
          action: 'api',
          methodPath: `${req.method} ${pathname}`,
          status: res.statusCode,
          ip: clientIp(req),
        })).catch(error => { console.error('[gateway] API audit write failed:', error) })
      })
      try {
        const response = await handlers.documentScope({
          user,
          request: req,
          pathname,
          operation: scopedOperation,
          scope,
          signal: abort.signal,
        })
        if (!abort.signal.aborted && !res.writableEnded) await sendGatewayResponse(res, response, cfg.upstreamResponseLimitBytes)
      } catch (error: unknown) {
        if (abort.signal.aborted || res.writableEnded) return
        if (error instanceof DocumentTransferError) {
          send(res, error.status, JSON.stringify({ error: { code: error.code, message: error.message } }), 'application/json')
        } else {
          send(res, 503, JSON.stringify({ error: { code: 'DOCUMENT_TRANSFER_UNAVAILABLE', message: 'Document scope is temporarily unavailable.' } }), 'application/json')
        }
      } finally {
        abort.dispose()
      }
      return
    }

    if (pathname === '/api/documents/transfer/list' && req.method === 'POST'
      && handlers.documentTransferList !== undefined) {
      let payload: unknown
      try {
        payload = JSON.parse(await readBody(req, cfg.runtimeApiBodyLimitBytes)) as unknown
      } catch (error: unknown) {
        if (error instanceof BodyTooLargeError) {
          send(res, 413, JSON.stringify({ error: { code: 'DOCUMENT_TRANSFER_TOO_LARGE', message: 'Document scope listing request is too large.' } }), 'application/json')
        } else {
          send(res, 400, JSON.stringify({ error: { code: 'INVALID_DOCUMENT_TRANSFER', message: 'Invalid document scope listing JSON.' } }), 'application/json')
        }
        return
      }
      const abort = new AbortController()
      const onRequestAbort = (): void => { if (!abort.signal.aborted) abort.abort(new Error('document request aborted')) }
      const onResponseClose = (): void => { if (!res.writableEnded) onRequestAbort() }
      req.once('aborted', onRequestAbort)
      res.once('close', onResponseClose)
      res.once('finish', () => {
        void Promise.resolve(audit.write({
          userId: user.id,
          action: 'api',
          methodPath: `${req.method} ${pathname}`,
          status: res.statusCode,
          ip: clientIp(req),
        })).catch(error => { console.error('[gateway] API audit write failed:', error) })
      })
      res.setHeader('cache-control', 'no-store')
      try {
        const result = await handlers.documentTransferList({ user, payload, signal: abort.signal })
        if (!abort.signal.aborted && !res.writableEnded) send(res, 200, JSON.stringify(result), 'application/json')
      } catch (error: unknown) {
        if (abort.signal.aborted || res.writableEnded) return
        if (error instanceof DocumentTransferError) {
          send(res, error.status, JSON.stringify({ error: { code: error.code, message: error.message } }), 'application/json')
          return
        }
        console.error('[gateway] document scope listing failed:', error)
        send(res, 503, JSON.stringify({
          error: { code: 'DOCUMENT_TRANSFER_UNAVAILABLE', message: 'Document scope listing is temporarily unavailable.' },
        }), 'application/json')
      } finally {
        req.removeListener('aborted', onRequestAbort)
        res.removeListener('close', onResponseClose)
      }
      return
    }

    if (pathname === '/account/api/context' && req.method === 'GET') {
      res.setHeader('cache-control', 'no-store')
      const resolved = await requestContext(req, user)
      const scopes = await deps.collaboration?.projectsForUser(user.id) ?? []
      // `projectsForUser` already establishes the membership set. Use one
      // scoped batch detail query for owner flags instead of scanning the
      // organization catalog or issuing one detail query per membership.
      const scopedIds = scopes.map(scope => scope.projectId)
      const scopedDetails = deps.projects.getByIds === undefined
        ? (scopedIds.length === 0 ? [] : await deps.projects.list())
        : await deps.projects.getByIds(scopedIds)
      const details = new Map(scopedDetails.map(project => [project.id, project]))
      const projects = await Promise.all(scopes.map(async (scope) => {
        const detail = details.get(scope.projectId)
        // Older in-process project catalogs may omit owner metadata. Preserve
        // the previous detail lookup only for those rows; production project
        // services include `owner` in every catalog row and stay one-query.
        const owner = detail?.owner !== undefined
          ? detail.owner
          : (await deps.projects.getById(scope.projectId))?.owner
        const canManage = scope.canManage === true || user.role === 'admin' || owner?.id === user.id
        return {
          ...scope,
          ...(canManage ? { canManage: true } : {}),
          ...(detail?.origin === undefined ? {} : { origin: detail.origin }),
          ...(detail?.owner === undefined ? {} : { owner: detail.owner }),
          ...(detail?.uiThemePolicy === undefined ? {} : { uiThemePolicy: detail.uiThemePolicy }),
        }
      }))
      const activeProjectId = resolved.context.scope.kind === 'project'
        ? resolved.context.scope.projectId
        : undefined
      const activeProject = activeProjectId === undefined
        ? undefined
        : projects.find(project => project.projectId === activeProjectId)
      const activeScope = activeProject === undefined
        ? resolved.context.scope
        : {
          ...resolved.context.scope,
          canManage: activeProject.canManage === true,
          ...(activeProject.uiThemePolicy === undefined ? {} : { uiThemePolicy: activeProject.uiThemePolicy }),
        }
      send(res, 200, JSON.stringify({
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
        },
        scope: activeScope,
        projects,
        // The shared project runtime remains confined to its project path;
        // this flag only advertises the administrator-only preset choice.
        fullAccess: user.role === 'admin',
      }), 'application/json')
      return
    }

    if (pathname === '/account/api/preferences') {
      if (deps.userPreferences === undefined) {
        // Older/embedded hosts do not own account storage. A 501 lets the
        // browser scope intentionally fall back to the Host settings file;
        // 503 is reserved for a configured service that is temporarily down.
        send(res, 501, JSON.stringify({ error: 'account-preferences-unsupported' }), 'application/json')
        return
      }
      try {
        if (req.method === 'GET') {
          const value = await deps.userPreferences.describe(user)
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(value))
          return
        }
        if (req.method === 'PATCH') {
          const mutation = normalizeAccountPreferenceMutation(jsonObject(await readBody(req)))
          const value = await deps.userPreferences.mutate(user, mutation)
          await audit.write({
            userId: user.id,
            action: 'account-preference.updated',
            detail: JSON.stringify({ namespace: mutation.namespace, field: mutation.field, operation: mutation.operation }),
            ip: clientIp(req),
          })
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(value))
          return
        }
        send(res, 405, JSON.stringify({ error: 'method-not-allowed' }), 'application/json')
      } catch (error: unknown) {
        if (error instanceof AccountPreferencesConflictError) {
          send(res, 409, JSON.stringify({ error: error.code, expected: error.expected, actual: error.actual }), 'application/json')
          return
        }
        if (error instanceof AccountPreferencesInputError) {
          send(res, 400, JSON.stringify({ error: error.code, message: error.message }), 'application/json')
          return
        }
        throw error
      }
      return
    }

    const projectConfiguration = /^\/account\/api\/projects\/(\d+)\/configuration$/.exec(pathname)
    if (projectConfiguration !== null) {
      res.setHeader('cache-control', 'no-store')
      const projectId = Number(projectConfiguration[1])
      if (!Number.isSafeInteger(projectId) || projectId <= 0) {
        send(res, 400, JSON.stringify({ error: 'invalid-project-id' }), 'application/json')
        return
      }
      if (deps.collaboration === undefined) {
        send(res, 503, JSON.stringify({ error: 'project-configuration-unavailable' }), 'application/json')
        return
      }
      const authority = await deps.collaboration.projectForUser(projectId, user.id)
      if (authority === null) {
        send(res, 403, JSON.stringify({ error: 'not-member' }), 'application/json')
        return
      }
      const project = await deps.projects.getById(projectId)
      if (project === null) {
        send(res, 404, JSON.stringify({ error: 'project-not-found' }), 'application/json')
        return
      }
      const canManage = user.role === 'admin' || project.owner?.id === user.id
        || authority.administrator
      const capabilities: ProjectConfigurationView['capabilities'] = {
        themePolicy: deps.projects.setThemePolicy !== undefined && canManage,
        runtimeSettings: canManage,
        projectModels: canManage && deps.governance?.describeProjectModelSettings !== undefined
          && deps.governance.mutateProjectModelSettings !== undefined,
        members: canManage,
        filesystem: false,
      }
      try {
        if (req.method === 'GET') {
          const value: ProjectConfigurationView = {
            project: {
              id: project.id,
              name: project.name,
              ...(project.origin === undefined ? {} : { origin: project.origin }),
              ...(project.owner === undefined ? {} : { owner: project.owner }),
              themePolicy: project.uiThemePolicy ?? 'follow-user',
            },
            canManage,
            capabilities,
          }
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(value))
          return
        }
        if (req.method === 'PATCH') {
          if (!canManage) {
            send(res, 403, JSON.stringify({ error: 'forbidden' }), 'application/json')
            return
          }
          if (deps.projects.setThemePolicy === undefined) {
            send(res, 501, JSON.stringify({ error: 'project-configuration-unsupported' }), 'application/json')
            return
          }
          const input = jsonObject(await readBody(req))
          const policy = input?.themePolicy
          if (policy !== 'follow-user' && policy !== 'light' && policy !== 'dark') {
            send(res, 400, JSON.stringify({ error: 'invalid-project-theme-policy' }), 'application/json')
            return
          }
          await deps.projects.setThemePolicy(projectId, policy as ProjectThemePolicy)
          await audit.write({
            userId: user.id,
            action: 'projects.configuration.theme-policy',
            detail: JSON.stringify({ projectId, themePolicy: policy }),
            ip: clientIp(req),
          })
          const next = await deps.projects.getById(projectId)
          if (next === null) throw new Error('project disappeared after configuration update')
          const value: ProjectConfigurationView = {
            project: {
              id: next.id,
              name: next.name,
              ...(next.origin === undefined ? {} : { origin: next.origin }),
              ...(next.owner === undefined ? {} : { owner: next.owner }),
              themePolicy: next.uiThemePolicy ?? policy as ProjectThemePolicy,
            },
            canManage,
            capabilities,
          }
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(value))
          return
        }
        send(res, 405, JSON.stringify({ error: 'method-not-allowed' }), 'application/json')
      } catch (error: unknown) {
        const mapped = accountProjectError(error)
        send(res, mapped.status, JSON.stringify({ error: mapped.error }), 'application/json')
      }
      return
    }

    // Project Provider settings deliberately use a Gateway-owned API instead
    // of the runtime's local settings document. This keeps encrypted keys and
    // the shared policy projection authoritative across every member device.
    const projectModelSettings = /^\/account\/api\/projects\/(\d+)\/model-settings(?:\/(credentials|discover))?$/.exec(pathname)
    if (projectModelSettings !== null) {
      res.setHeader('cache-control', 'no-store')
      const projectId = Number(projectModelSettings[1])
      const suffix = projectModelSettings[2]
      if (!Number.isSafeInteger(projectId) || projectId <= 0) {
        send(res, 400, JSON.stringify({ error: 'invalid-project-model-settings-request' }), 'application/json')
        return
      }
      if (deps.collaboration === undefined) {
        send(res, 503, JSON.stringify({ error: 'project-model-settings-unavailable' }), 'application/json')
        return
      }
      if (deps.governance === undefined) {
        send(res, 501, JSON.stringify({ error: 'project-model-settings-unsupported' }), 'application/json')
        return
      }
      const authority = await deps.collaboration.projectForUser(projectId, user.id)
      if (authority === null) {
        send(res, 403, JSON.stringify({ error: 'not-member' }), 'application/json')
        return
      }
      const detail = await deps.projects.getById(projectId)
      if (detail === null) {
        send(res, 404, JSON.stringify({ error: 'project-not-found' }), 'application/json')
        return
      }
      const canManage = user.role === 'admin' || authority.administrator || detail.owner?.id === user.id
      try {
        if (suffix === 'discover') {
          if (deps.governance.discoverProjectModels === undefined) {
            send(res, 501, JSON.stringify({ error: 'project-model-settings-unsupported' }), 'application/json')
            return
          }
          if (req.method !== 'POST' || !canManage) {
            send(res, canManage ? 405 : 403, JSON.stringify({ error: canManage ? 'method-not-allowed' : 'forbidden' }), 'application/json')
            return
          }
          const input = jsonObject(await readBody(req))
          const models = await deps.governance.discoverProjectModels({
            projectId,
            ...stringField(input?.provider) === undefined ? {} : { provider: stringField(input?.provider) },
            ...stringField(input?.baseURL) === undefined ? {} : { baseURL: stringField(input?.baseURL) },
            ...stringField(input?.api) === undefined ? {} : { api: stringField(input?.api) },
            ...stringField(input?.apiKey) === undefined ? {} : { apiKey: stringField(input?.apiKey) },
          })
          send(res, 200, JSON.stringify({ models }), 'application/json')
          return
        }
        if (suffix === 'credentials') {
          if (req.method === 'GET') {
            const query = new URL(req.url ?? '/', 'http://gateway').searchParams
            const refs = query.getAll('refs').flatMap(value => value.split(',')).map(value => value.trim()).filter(value => value !== '')
            if (deps.governance.describeProjectCredentials === undefined) {
              send(res, 501, JSON.stringify({ error: 'project-model-settings-unsupported' }), 'application/json')
              return
            }
            const described = await deps.governance.describeProjectCredentials(projectId, [...new Set(refs)])
            send(res, 200, JSON.stringify({
              credentials: Object.fromEntries(Object.entries(described).map(([ref, value]) => [
                ref, { ...value, writable: canManage && value.writable },
              ])),
            }), 'application/json')
            return
          }
          if (!canManage) {
            send(res, 403, JSON.stringify({ error: 'forbidden' }), 'application/json')
            return
          }
          const input = jsonObject(await readBody(req))
          const ref = stringField(input?.ref)
          if (ref === undefined) {
            send(res, 400, JSON.stringify({ error: 'ref-required' }), 'application/json')
            return
          }
          if (req.method === 'PUT') {
            const value = typeof input?.value === 'string' ? input.value : undefined
            if (deps.governance.setProjectCredential === undefined) {
              send(res, 501, JSON.stringify({ error: 'project-model-settings-unsupported' }), 'application/json')
              return
            }
            if (value === undefined || value.trim() === '') {
              send(res, 400, JSON.stringify({ error: 'credential-required' }), 'application/json')
              return
            }
            await deps.governance.setProjectCredential(projectId, ref, value)
            await applyProjectGovernanceBestEffort(deps, projectId)
            await audit.write({ userId: user.id, action: 'projects.model-credential.set', detail: JSON.stringify({ projectId, ref }), ip: clientIp(req) })
            res.writeHead(204); res.end()
            return
          }
          if (req.method === 'DELETE') {
            if (deps.governance.unsetProjectCredential === undefined) {
              send(res, 501, JSON.stringify({ error: 'project-model-settings-unsupported' }), 'application/json')
              return
            }
            await deps.governance.unsetProjectCredential(projectId, ref)
            await applyProjectGovernanceBestEffort(deps, projectId)
            await audit.write({ userId: user.id, action: 'projects.model-credential.unset', detail: JSON.stringify({ projectId, ref }), ip: clientIp(req) })
            res.writeHead(204); res.end()
            return
          }
          send(res, 405, JSON.stringify({ error: 'method-not-allowed' }), 'application/json')
          return
        }
        if (req.method === 'GET') {
          if (deps.governance.describeProjectModelSettings === undefined) {
            send(res, 501, JSON.stringify({ error: 'project-model-settings-unsupported' }), 'application/json')
            return
          }
          const view = await deps.governance.describeProjectModelSettings(projectId)
          if (canManage) {
            send(res, 200, JSON.stringify(view), 'application/json')
          } else {
            send(res, 200, JSON.stringify({
              ...view,
              writable: false,
              namespaces: view.namespaces.map(namespace => ({
                ...namespace, writable: false, writableReason: 'project' as const,
              })),
            }), 'application/json')
          }
          return
        }
        if (req.method === 'PUT' || req.method === 'PATCH') {
          if (!canManage) {
            send(res, 403, JSON.stringify({ error: 'forbidden' }), 'application/json')
            return
          }
          if (deps.governance.mutateProjectModelSettings === undefined) {
            send(res, 501, JSON.stringify({ error: 'project-model-settings-unsupported' }), 'application/json')
            return
          }
          const input = jsonObject(await readBody(req))
          const ops = projectSettingsOps(input?.ops)
          const expectedRevision = input?.expectedRevision
          if (ops === undefined || (expectedRevision !== undefined
            && (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0))) {
            send(res, 400, JSON.stringify({ error: 'invalid-project-model-settings' }), 'application/json')
            return
          }
          const view = await deps.governance.mutateProjectModelSettings(projectId, ops, expectedRevision as number | undefined)
          await applyProjectGovernanceBestEffort(deps, projectId)
          await audit.write({ userId: user.id, action: 'projects.model-settings.mutate', detail: JSON.stringify({ projectId, opCount: ops.length }), ip: clientIp(req) })
          send(res, 200, JSON.stringify(view), 'application/json')
          return
        }
        send(res, 405, JSON.stringify({ error: 'method-not-allowed' }), 'application/json')
      } catch (error: unknown) {
        if (error instanceof ProjectModelSettingsConflictError) {
          send(res, 409, JSON.stringify({ error: error.code, expected: error.expected, actual: error.actual }), 'application/json')
          return
        }
        const mapped = accountProjectError(error)
        send(res, mapped.status, JSON.stringify({ error: mapped.error }), 'application/json')
      }
      return
    }

    const documentOwnership = /^\/account\/api\/documents\/([^/]+)\/ownership$/.exec(pathname)
    if (documentOwnership !== null && req.method === 'POST') {
      if (deps.documents === undefined) { send(res, 503, '{"error":"document-catalog-unavailable"}', 'application/json'); return }
      let catalogId: string
      try { catalogId = decodeURIComponent(documentOwnership[1] ?? '') } catch { send(res, 400, '{"error":"invalid-document-id"}', 'application/json'); return }
      const input = jsonObject(await readBody(req))
      const ownerUserId = input?.ownerUserId
      if (!/^[0-9a-f-]{36}$/iu.test(catalogId) || typeof ownerUserId !== 'number'
        || !Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) {
        send(res, 400, '{"error":"invalid-ownership-request"}', 'application/json'); return
      }
      try {
        await deps.documents.transferOwnership(user.id, catalogId, ownerUserId)
        await audit.write({ userId: user.id, action: 'documents.ownership-transfer', detail: JSON.stringify({ catalogId, ownerUserId }), ip: clientIp(req) })
        res.writeHead(204); res.end()
      } catch (error) {
        const status = error instanceof Error && 'status' in error && typeof (error as { status?: unknown }).status === 'number'
          ? (error as { status: number }).status : 400
        send(res, status, JSON.stringify({ error: error instanceof Error && 'code' in error ? (error as { code: string }).code : 'ownership-failed' }), 'application/json')
      }
      return
    }

    if (pathname === '/account/api/users' && req.method === 'GET') {
      const all = await users.list()
      const active = all.filter(u => u.status === 'active').map(u => ({
        id: u.id, username: u.username, displayName: u.displayName,
      }))
      send(res, 200, JSON.stringify(active), 'application/json')
      return
    }

    if (pathname === '/account/api/projects') {
      try {
        if (req.method === 'GET') {
          const scopes = await deps.collaboration?.projectsForUser(user.id) ?? []
          const details = deps.projects.getByIds === undefined
            ? await Promise.all(scopes.map(scope => deps.projects.getById(scope.projectId)))
            : await deps.projects.getByIds(scopes.map(scope => scope.projectId))
          send(res, 200, JSON.stringify(details.filter((project): project is NonNullable<typeof project> => project !== null).map(project => ({
            ...project,
            canManage: user.role === 'admin' || project.owner?.id === user.id,
          }))), 'application/json')
          return
        }
        if (req.method === 'POST') {
          const input = jsonObject(await readBody(req))
          const name = stringField(input?.name)
          if (name === undefined) { send(res, 400, '{"error":"name required"}', 'application/json'); return }
          if (deps.projects.createManaged === undefined) {
            send(res, 503, '{"error":"managed-projects-unavailable"}', 'application/json'); return
          }
          const project = await deps.projects.createManaged({ name, ownerUserId: user.id })
          await audit.write({ userId: user.id, action: 'projects.create', detail: JSON.stringify({ id: project.id, origin: 'user' }), ip: clientIp(req) })
          send(res, 201, JSON.stringify(project), 'application/json')
          return
        }
        send(res, 405, '{"error":"method-not-allowed"}', 'application/json')
      } catch (error) {
        const mapped = accountProjectError(error)
        send(res, mapped.status, JSON.stringify({ error: mapped.error }), 'application/json')
      }
      return
    }

    if (pathname === '/account/api/invitations/count' && req.method === 'GET') {
      if (deps.projects.countPendingInvitations === undefined) {
        send(res, 503, '{"error":"invitations-unavailable"}', 'application/json'); return
      }
      send(res, 200, JSON.stringify({ pending: await deps.projects.countPendingInvitations(user.id) }), 'application/json')
      return
    }

    if (pathname === '/account/api/invitations' && req.method === 'GET') {
      if (deps.projects.listInvitations === undefined) {
        send(res, 503, '{"error":"invitations-unavailable"}', 'application/json'); return
      }
      send(res, 200, JSON.stringify(await deps.projects.listInvitations(user.id)), 'application/json')
      return
    }

    const invitationAccept = pathname.match(/^\/account\/api\/invitations\/([^/]+)\/accept$/)
    if (invitationAccept !== null && req.method === 'POST') {
      if (deps.projects.acceptInvitation === undefined) {
        send(res, 503, '{"error":"invitations-unavailable"}', 'application/json'); return
      }
      try {
        await deps.projects.acceptInvitation(decodeURIComponent(invitationAccept[1] ?? ''), user.id)
        await audit.write({ userId: user.id, action: 'projects.invitation.accept', ip: clientIp(req) })
        res.writeHead(204); res.end()
      } catch (error) {
        if (error instanceof URIError) {
          send(res, 400, JSON.stringify({ error: 'invalid-invitation-id' }), 'application/json')
          return
        }
        const mapped = accountProjectError(error)
        send(res, mapped.status, JSON.stringify({ error: mapped.error }), 'application/json')
      }
      return
    }

    const accountProjectPath = pathname.match(/^\/account\/api\/projects\/(\d+)(?:\/(invitations))?$/)
    if (accountProjectPath !== null) {
      const projectId = Number(accountProjectPath[1])
      const isInvitationPath = accountProjectPath[2] !== undefined
      try {
        const project = await deps.projects.getById(projectId)
        if (project === null) { send(res, 404, '{"error":"project-not-found"}', 'application/json'); return }
        const authority = await deps.collaboration?.projectForUser(projectId, user.id)
        if (authority === null || authority === undefined) { send(res, 403, '{"error":"not-member"}', 'application/json'); return }
        const canManage = user.role === 'admin' || authority.administrator || project.owner?.id === user.id
        if (isInvitationPath) {
          if (req.method === 'GET') {
            if (deps.projects.listInvitations === undefined) { send(res, 503, '{"error":"invitations-unavailable"}', 'application/json'); return }
            send(res, 200, JSON.stringify(await deps.projects.listInvitations(user.id, projectId)), 'application/json'); return
          }
          if (req.method === 'POST') {
            if (!canManage || deps.projects.createInvitation === undefined) { send(res, 403, '{"error":"forbidden"}', 'application/json'); return }
            const input = jsonObject(await readBody(req))
            const username = stringField(input?.username)
            const mode = input?.mode === 'ro' || input?.mode === 'rw' ? input.mode : undefined
            if (username === undefined || mode === undefined) { send(res, 400, '{"error":"username and mode required"}', 'application/json'); return }
            const invitee = await users.getByUsername(username)
            if (invitee === null) { send(res, 404, '{"error":"user-not-found"}', 'application/json'); return }
            if (invitee.id === user.id) { send(res, 400, '{"error":"cannot-invite-self"}', 'application/json'); return }
            const invitation = await deps.projects.createInvitation({ projectId, inviteeUserId: invitee.id, inviterUserId: user.id, mode })
            await audit.write({ userId: user.id, action: 'projects.invitation.create', detail: JSON.stringify({ projectId, inviteeUserId: invitee.id, mode }), ip: clientIp(req) })
            send(res, 201, JSON.stringify(invitation), 'application/json'); return
          }
          send(res, 405, '{"error":"method-not-allowed"}', 'application/json'); return
        }
        if (req.method === 'GET') {
          send(res, 200, JSON.stringify({ ...project, canManage }), 'application/json'); return
        }
        if (req.method === 'PATCH') {
          if (!canManage) { send(res, 403, '{"error":"forbidden"}', 'application/json'); return }
          const name = stringField(jsonObject(await readBody(req))?.name)
          if (name === undefined) { send(res, 400, '{"error":"name required"}', 'application/json'); return }
          await deps.projects.rename(projectId, name)
          await audit.write({ userId: user.id, action: 'projects.rename', detail: JSON.stringify({ projectId, name }), ip: clientIp(req) })
          res.writeHead(204); res.end(); return
        }
        send(res, 405, '{"error":"method-not-allowed"}', 'application/json')
      } catch (error) {
        const mapped = accountProjectError(error)
        send(res, mapped.status, JSON.stringify({ error: mapped.error }), 'application/json')
      }
      return
    }

    if (pathname === '/account/api/conversations' && req.method === 'GET') {
      if (resolved.context.scope.kind !== 'project' || deps.collaboration === undefined) {
        send(res, 400, '{"error":"project-scope-required"}', 'application/json')
        return
      }
      send(res, 200, JSON.stringify({
        items: await deps.collaboration.listConversations(user.id, resolved.context.scope.projectId),
      }), 'application/json')
      return
    }

    const conversationRoute = pathname.match(/^\/account\/api\/conversations\/([^/]+)$/)
    if (conversationRoute !== null && deps.collaboration !== undefined) {
      try {
        const sessionId = decodeURIComponent(conversationRoute[1] ?? '')
        if (req.method === 'GET') {
          const access = await deps.collaboration.access(user.id, sessionId, 'read')
          const items = await deps.collaboration.listConversations(user.id, access.projectId)
          send(res, 200, JSON.stringify({ access, conversation: items.find(item => item.sessionId === access.rootSessionId) ?? null }), 'application/json')
          return
        }
        if (req.method === 'PATCH') {
          const body = JSON.parse(await readBody(req)) as { visibility?: unknown }
          if (body.visibility !== 'project' && body.visibility !== 'private') {
            send(res, 400, '{"error":"invalid-visibility"}', 'application/json')
            return
          }
          await deps.collaboration.setVisibility(user.id, sessionId, body.visibility)
          res.writeHead(204)
          res.end()
          return
        }
      } catch (error) {
        if (error instanceof CollaborationDeniedError) {
          const status = error.code === 'conversation-not-found' ? 404
            : error.code === 'visibility-locked' ? 409 : 403
          send(res, status, JSON.stringify({ error: error.code }), 'application/json')
          return
        }
        if (error instanceof SyntaxError) {
          send(res, 400, '{"error":"invalid-json"}', 'application/json')
          return
        }
        if (error instanceof URIError) {
          send(res, 400, '{"error":"invalid-session-id"}', 'application/json')
          return
        }
        throw error
      }
    }

    if (isAdminPath(pathname)) {
      if (user.role !== 'admin') { sendAdminGate(res, pathname, 'forbidden'); return }
      const projectSettingsRedirect = /^\/admin\/projects\/(\d+)\/settings$/.exec(pathname)
      if (projectSettingsRedirect !== null && req.method === 'GET') {
        const projectId = Number(projectSettingsRedirect[1])
        const project = Number.isSafeInteger(projectId) && projectId > 0
          ? await deps.projects.getById(projectId)
          : null
        if (project === null) {
          send(res, 404, 'not found', 'text/plain')
          return
        }
        await deps.instances.ensureRunning({ kind: 'project', id: project.id, name: project.name, path: project.path })
        redirect(res, '/', [scopeCookie(`project:${project.id}`, cfg)])
        return
      }
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req)
      if (handlers.admin !== undefined && await handlers.admin(req, res, user, pathname, body)) return
      if (serveAdmin(req, res, pathname, handlers.adminRoot)) return
      send(res, 404, 'not found', 'text/plain')
      return
    }

    if (handlers.proxy !== undefined) { await handlers.proxy(req, res, resolved.context); return }
    send(res, 503, '{"error":"proxy-not-configured"}', 'application/json')
  }

  server.on('upgrade', (req, socket, head) => {
    const finish = async (): Promise<void> => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const origin = req.headers.origin
      if (origin !== undefined && !cfg.publicOrigins.includes(origin)) { socket.destroy(); return }
      const session = await currentUser(req)
      if (session === null || session.user.mustChangePassword) { socket.destroy(); return }
      if (handlers.upgrade === undefined || !pathname.startsWith('/api')) { socket.destroy(); return }
      const resolved = await requestContext(req, session.user)
      await handlers.upgrade(req, socket, head, resolved.context)
    }
    void finish().catch(() => socket.destroy())
  })

  return server
}
