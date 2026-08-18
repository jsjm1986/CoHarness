import type { IncomingMessage, ServerResponse } from 'node:http'
import { applyGrantsToUser } from './apply-grants.ts'
import { applyModelGovernanceToProject, applyModelGovernanceToUser } from './apply-model-governance.ts'
import type { UserRow } from './auth.ts'
import { CollaborationDeniedError } from './collaboration.ts'
import type {
  ModelProviderAuthMode,
  ModelProviderProtocol,
  ModelProviderStatus,
  ModelSettingsPathOp,
} from './model-governance.ts'
import { listProjectDirectories } from './project-directories.ts'
import type { GrantMode } from './projects.ts'
import type { GatewayDeps, GatewayHandlers } from './server.ts'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { error })
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204)
  res.end()
}

function parseObject(body: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(body) } catch { throw new Error('invalid json') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid json')
  return value as Record<string, unknown>
}

function str(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === 'string' ? value : undefined
}

function isCodedError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'
}

function mapError(error: unknown): { status: number; error: string } {
  if (error instanceof Error && error.message === 'cannot-remove-last-admin') {
    return { status: 409, error: 'cannot-remove-last-admin' }
  }
  if (error instanceof Error && error.message === 'cannot-delete-self') {
    return { status: 409, error: 'cannot-delete-self' }
  }
  if (error instanceof CollaborationDeniedError && error.code === 'visibility-locked') {
    return { status: 409, error: error.code }
  }
  if (error instanceof Error && (error.message === 'owner-protected' || error.message === 'owner-must-be-rw')) {
    return { status: 409, error: error.message }
  }
  if (error instanceof Error && error.message === 'invalid json') {
    return { status: 400, error: 'invalid json' }
  }
  if (error instanceof Error && error.message.startsWith('duplicate ')) {
    return { status: 409, error: error.message }
  }
  if (error instanceof Error && error.message === 'project-path-overlap') {
    return { status: 409, error: error.message }
  }
  if (error instanceof Error && error.message === 'settings-conflict') {
    return { status: 409, error: error.message }
  }
  if (isCodedError(error) && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return { status: 409, error: 'duplicate' }
  }
  return { status: 400, error: error instanceof Error ? error.message : String(error) }
}

/**
 * JSON router for `/admin/api/*`. Other `/admin` paths return false so static hosting can serve them.
 * @param deps - users, projects, audit, instances
 * @returns admin handler that writes 200 JSON, 204, or `{ error }` at 400/404/409
 */
export function createAdminApiHandler(deps: GatewayDeps): NonNullable<GatewayHandlers['admin']> {
  return async (req: IncomingMessage, res: ServerResponse, admin: UserRow, pathname: string, body: string): Promise<boolean> => {
    if (!pathname.startsWith('/admin/api')) return false
    try {
      const ok = await dispatch(deps, req, res, admin, pathname, body)
      if (!ok) sendError(res, 404, 'not found')
    } catch (error) {
      if (res.writableEnded) throw error
      const mapped = mapError(error)
      sendError(res, mapped.status, mapped.error)
    }
    return true
  }
}

async function dispatch(
  deps: GatewayDeps,
  req: IncomingMessage,
  res: ServerResponse,
  admin: UserRow,
  pathname: string,
  body: string,
): Promise<boolean> {
  const method = req.method ?? 'GET'
  const ip = req.socket.remoteAddress ?? ''
  const write = async (action: string, detail: Record<string, unknown>): Promise<void> =>
    deps.audit.write({ userId: admin.id, action, detail: JSON.stringify(detail), ip })

  const refreshModelPolicies = async (): Promise<void> => {
    if (deps.governance === undefined) return
    for (const target of await deps.users.list()) await applyModelGovernanceToUser(deps, target.id)
    for (const project of await deps.projects.list()) await applyModelGovernanceToProject(deps, project.id)
  }

  const settingsOps = (value: unknown): ModelSettingsPathOp[] => {
    if (!Array.isArray(value) || value.length === 0) throw new Error('ops must be a non-empty array')
    return value.map((raw, index) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`ops[${String(index)}] must be an object`)
      const op = raw as Record<string, unknown>
      const path = op.path
      if (!Array.isArray(path) || path.some(segment => typeof segment !== 'string' || segment.length === 0)) {
        throw new Error(`ops[${String(index)}].path must be a non-empty string array`)
      }
      if (op.op === 'unset') return { op: 'unset', path: [...path] }
      if (op.op === 'set' && Object.hasOwn(op, 'value')) return { op: 'set', path: [...path], value: op.value }
      throw new Error(`ops[${String(index)}] must be set or unset`)
    })
  }

  const apply = async (userId: number): Promise<void> => {
    const prior = await deps.audit.query({ action: 'admin.instances.restart-failed', userId: admin.id })
    try {
      await applyGrantsToUser(deps, userId, admin.id)
    } catch (error) {
      const next = await deps.audit.query({ action: 'admin.instances.restart-failed', userId: admin.id })
      if (next.length > prior.length) return
      throw error
    }
  }

  if (pathname === '/admin/api/users') {
    if (method === 'GET') { sendJson(res, 200, await deps.users.list()); return true }
    if (method === 'POST') {
      const input = parseObject(body)
      const username = str(input, 'username')
      const password = str(input, 'password')
      if (username === undefined || password === undefined) { sendError(res, 400, 'username and password required'); return true }
      const role = str(input, 'role') === 'admin' ? 'admin' as const : 'user' as const
      const displayName = str(input, 'displayName')
      const user = await deps.users.create({ username, password, role, displayName })
      await write('admin.users', { username, role })
      sendJson(res, 200, user)
      return true
    }
    return false
  }

  const userInstance = /^\/admin\/api\/users\/(\d+)\/instance\/(start|stop|restart)$/.exec(pathname)
  if (userInstance !== null) {
    if (method !== 'POST') return false
    const userId = Number(userInstance[1])
    const op = userInstance[2] as 'start' | 'stop' | 'restart'
    const target = await deps.users.getById(userId)
    if (target === null) { sendError(res, 404, 'user not found'); return true }
    if (op === 'stop') await deps.instances.stop(userId)
    else if (op === 'start') await deps.instances.ensureRunning(target)
    else {
      await deps.instances.stop(userId)
      await deps.instances.ensureRunning(target)
    }
    await write(`admin.instances.${op}`, { id: userId })
    sendNoContent(res)
    return true
  }

  const userPassword = /^\/admin\/api\/users\/(\d+)\/password$/.exec(pathname)
  if (userPassword !== null) {
    if (method !== 'POST') return false
    const userId = Number(userPassword[1])
    if (await deps.users.getById(userId) === null) { sendError(res, 404, 'user not found'); return true }
    const password = str(parseObject(body), 'password')
    if (password === undefined) { sendError(res, 400, 'password required'); return true }
    await deps.users.resetPassword(userId, password)
    await write('admin.users.reset-password', { id: userId })
    sendNoContent(res)
    return true
  }

  const userIdPath = /^\/admin\/api\/users\/(\d+)$/.exec(pathname)
  if (userIdPath !== null) {
    const userId = Number(userIdPath[1])
    const target = await deps.users.getById(userId)
    if (target === null) { sendError(res, 404, 'user not found'); return true }
    if (method === 'DELETE') {
      if (userId === admin.id) throw new Error('cannot-delete-self')
      const removed = await deps.instances.withStopped(
        userId,
        async () => deps.users.remove(userId),
      )
      if (!removed) { sendError(res, 404, 'user not found'); return true }
      await write('admin.users.delete', { id: userId, username: target.username })
      sendNoContent(res)
      return true
    }
    if (method !== 'PATCH') return false
    const input = parseObject(body)
    const displayName = str(input, 'displayName')
    const role = str(input, 'role')
    const status = str(input, 'status')
    if (role !== undefined && role !== 'admin' && role !== 'user') { sendError(res, 400, 'invalid role'); return true }
    if (status !== undefined && status !== 'active' && status !== 'disabled') { sendError(res, 400, 'invalid status'); return true }
    if (role !== undefined) {
      await deps.users.setRole(userId, role)
      await applyGrantsToUser(deps, userId, admin.id)
      if (deps.governance !== undefined) await applyModelGovernanceToUser(deps, userId)
      await write('admin.users.role', { id: userId, role })
    }
    if (status !== undefined) {
      await deps.users.setStatus(userId, status)
      if (status === 'disabled') await deps.instances.stop(userId)
      await write('admin.users.status', { id: userId, status })
    }
    if (displayName !== undefined) {
      await deps.users.setDisplayName(userId, displayName)
      await write('admin.users.display-name', { id: userId })
    }
    sendNoContent(res)
    return true
  }

  if (pathname === '/admin/api/models') {
    if (deps.governance === undefined) { sendError(res, 503, 'model governance unavailable'); return true }
    if (method === 'GET') { sendJson(res, 200, await deps.governance.listModels()); return true }
    if (method === 'PUT') {
      const input = parseObject(body)
      const provider = str(input, 'provider'); const model = str(input, 'model'); const displayName = str(input, 'displayName')
      if (provider === undefined || model === undefined || displayName === undefined) { sendError(res, 400, 'provider, model and displayName required'); return true }
      const bool = (key: string, fallback: boolean): boolean => {
        const value = input[key]
        if (value === undefined) return fallback
        if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`)
        return value
      }
      const integer = (key: string): number => {
        const value = input[key]
        if (value === undefined) return 0
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
          throw new Error(`${key} must be a non-negative safe integer`)
        }
        return value
      }
      await deps.governance.upsertModel({
        provider, model, displayName, enabled: bool('enabled', true), adminAllowed: bool('adminAllowed', true),
        userAllowed: bool('userAllowed', false), inputMicrosPerMillion: integer('inputMicrosPerMillion'),
        outputMicrosPerMillion: integer('outputMicrosPerMillion'), cacheReadMicrosPerMillion: integer('cacheReadMicrosPerMillion'),
        cacheWriteMicrosPerMillion: integer('cacheWriteMicrosPerMillion'),
      })
      await write('admin.models.upsert', { provider, model })
      for (const target of await deps.users.list()) await applyModelGovernanceToUser(deps, target.id)
      for (const project of await deps.projects.list()) await applyModelGovernanceToProject(deps, project.id)
      sendNoContent(res); return true
    }
    return false
  }

  if (pathname === '/admin/api/model-settings') {
    if (deps.governance === undefined) { sendError(res, 503, 'model governance unavailable'); return true }
    if (method === 'GET') {
      sendJson(res, 200, await deps.governance.describeOrganizationModelSettings())
      return true
    }
    if (method === 'PUT') {
      const input = parseObject(body)
      const expectedRevision = input.expectedRevision
      if (expectedRevision !== undefined && (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
        sendError(res, 400, 'expectedRevision must be a non-negative safe integer')
        return true
      }
      const view = await deps.governance.mutateOrganizationModelSettings(
        settingsOps(input.ops),
        expectedRevision as number | undefined,
      )
      await refreshModelPolicies()
      await write('admin.model-settings.mutate', { opCount: (input.ops as unknown[]).length })
      sendJson(res, 200, view)
      return true
    }
    return false
  }

  if (pathname === '/admin/api/model-settings/credentials') {
    if (deps.governance === undefined) { sendError(res, 503, 'model governance unavailable'); return true }
    const query = new URL(req.url ?? '/', 'http://x').searchParams
    const queryRefs = query.getAll('refs').flatMap(value => value.split(',')).map(value => value.trim()).filter(value => value !== '')
    if (method === 'GET') {
      sendJson(res, 200, { credentials: await deps.governance.describeOrganizationCredentials([...new Set(queryRefs)]) })
      return true
    }
    const input = parseObject(body)
    const ref = str(input, 'ref') ?? query.get('ref') ?? undefined
    if (ref === undefined) { sendError(res, 400, 'ref required'); return true }
    if (method === 'PUT') {
      const value = str(input, 'value')
      if (value === undefined) { sendError(res, 400, 'value required'); return true }
      await deps.governance.setOrganizationCredential(ref, value)
      await refreshModelPolicies()
      await write('admin.model-settings.credential.set', { ref })
      sendNoContent(res)
      return true
    }
    if (method === 'DELETE') {
      await deps.governance.unsetOrganizationCredential(ref)
      await refreshModelPolicies()
      await write('admin.model-settings.credential.unset', { ref })
      sendNoContent(res)
      return true
    }
    return false
  }

  if (pathname === '/admin/api/model-settings/discover') {
    if (deps.governance === undefined || method !== 'POST') return false
    const input = parseObject(body)
    const provider = str(input, 'provider')
    const baseURL = str(input, 'baseURL')
    const api = str(input, 'api')
    const apiKey = str(input, 'apiKey')
    sendJson(res, 200, {
      models: await deps.governance.discoverOrganizationModels({
        ...provider === undefined ? {} : { provider },
        ...baseURL === undefined ? {} : { baseURL },
        ...api === undefined ? {} : { api },
        ...apiKey === undefined ? {} : { apiKey },
      }),
    })
    return true
  }

  if (pathname === '/admin/api/model-providers') {
    if (deps.governance === undefined) { sendError(res, 503, 'model governance unavailable'); return true }
    if (method === 'GET') { sendJson(res, 200, await deps.governance.listProviders()); return true }
    if (method === 'PUT') {
      const input = parseObject(body)
      const provider = str(input, 'provider')
      const displayName = str(input, 'displayName')
      const driver = str(input, 'driver')
      const protocol = str(input, 'protocol')
      const baseURL = str(input, 'baseURL')
      const authMode = str(input, 'authMode')
      const status = str(input, 'status')
      const credential = input.credential
      if (provider === undefined || displayName === undefined || driver !== 'pi-ai'
        || (protocol !== 'openai-completions' && protocol !== 'openai-responses'
          && protocol !== 'anthropic-messages')
        || baseURL === undefined || (authMode !== 'api-key' && authMode !== 'none')
        || (status !== 'draft' && status !== 'enabled' && status !== 'disabled' && status !== 'archived')
        || (credential !== undefined && credential !== null && typeof credential !== 'string')) {
        sendError(res, 400, 'valid provider, displayName, driver, protocol, baseURL, authMode and status required')
        return true
      }
      await deps.governance.upsertProvider({
        provider,
        displayName,
        driver,
        protocol: protocol as ModelProviderProtocol,
        baseURL,
        authMode: authMode as ModelProviderAuthMode,
        status: status as ModelProviderStatus,
        ...credential === undefined ? {} : { credential: credential as string | null },
      })
      await write('admin.model-providers.upsert', { provider, status })
      for (const target of await deps.users.list()) await applyModelGovernanceToUser(deps, target.id)
      for (const project of await deps.projects.list()) await applyModelGovernanceToProject(deps, project.id)
      sendNoContent(res)
      return true
    }
    return false
  }

  if (pathname === '/admin/api/model-access') {
    if (deps.governance === undefined) { sendError(res, 503, 'model governance unavailable'); return true }
    const query = new URL(req.url ?? '/', 'http://x').searchParams
    if (method === 'GET') {
      const userId = Number(query.get('userId'))
      const target = await deps.users.getById(userId)
      if (target === null) { sendError(res, 404, 'user not found'); return true }
      sendJson(res, 200, {
        effective: await deps.governance.policyFor(target),
        overrides: await deps.governance.userOverrides(userId),
      }); return true
    }
    if (method === 'PUT') {
      const input = parseObject(body); const userId = Number(input.userId); const provider = str(input, 'provider'); const model = str(input, 'model')
      const allowed = input.allowed
      if (!Number.isSafeInteger(userId) || provider === undefined || model === undefined || (allowed !== null && typeof allowed !== 'boolean')) {
        sendError(res, 400, 'userId, provider, model and boolean|null allowed required'); return true
      }
      if (await deps.users.getById(userId) === null) { sendError(res, 404, 'user not found'); return true }
      await deps.governance.setUserAccess(userId, provider, model, allowed as boolean | null)
      await applyModelGovernanceToUser(deps, userId)
      await write('admin.models.user-access', { userId, provider, model, allowed }); sendNoContent(res); return true
    }
    return false
  }

  if (pathname === '/admin/api/project-model-access') {
    if (deps.governance === undefined) { sendError(res, 503, 'model governance unavailable'); return true }
    const query = new URL(req.url ?? '/', 'http://x').searchParams
    if (method === 'GET') {
      const projectId = Number(query.get('projectId'))
      if (await deps.projects.getById(projectId) === null) { sendError(res, 404, 'project not found'); return true }
      sendJson(res, 200, {
        effective: await deps.governance.policyForProject(projectId),
        overrides: await deps.governance.projectOverrides(projectId),
      })
      return true
    }
    if (method === 'PUT') {
      const input = parseObject(body)
      const projectId = Number(input.projectId)
      const provider = str(input, 'provider')
      const model = str(input, 'model')
      const allowed = input.allowed
      if (!Number.isSafeInteger(projectId) || provider === undefined || model === undefined
        || (allowed !== null && typeof allowed !== 'boolean')) {
        sendError(res, 400, 'projectId, provider, model and boolean|null allowed required')
        return true
      }
      if (await deps.projects.getById(projectId) === null) { sendError(res, 404, 'project not found'); return true }
      await deps.governance.setProjectAccess(projectId, provider, model, allowed as boolean | null)
      await applyModelGovernanceToProject(deps, projectId)
      await write('admin.models.project-access', { projectId, provider, model, allowed })
      sendNoContent(res)
      return true
    }
    return false
  }

  if (pathname === '/admin/api/quotas') {
    if (deps.governance === undefined || method !== 'PUT') return false
    const input = parseObject(body); const subjectType = str(input, 'subjectType'); const subjectId = str(input, 'subjectId')
    if ((subjectType !== 'role' && subjectType !== 'user' && subjectType !== 'project') || subjectId === undefined) {
      sendError(res, 400, 'invalid quota subject'); return true
    }
    const nullable = (key: string): number | null | 'inherit' => {
      if (!Object.hasOwn(input, key)) throw new Error(`${key} required`)
      const value = input[key]
      if (value === 'inherit') return 'inherit'
      if (value === null) return null
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${key} must be a non-negative safe integer, null, or inherit`)
      }
      return value
    }
    await deps.governance.setQuota(subjectType, subjectId, nullable('tokenLimit'), nullable('companyCostMicrosLimit'))
    await write('admin.models.quota', { subjectType, subjectId }); sendNoContent(res); return true
  }

  if (pathname === '/admin/api/usage') {
    if (deps.governance === undefined || method !== 'GET') return false
    const query = new URL(req.url ?? '/', 'http://x').searchParams
    const month = query.get('month') ?? undefined
    const requestedProject = query.get('projectId')
    if (requestedProject !== null) {
      const projectId = Number(requestedProject)
      if (await deps.projects.getById(projectId) === null) { sendError(res, 404, 'project not found'); return true }
      sendJson(res, 200, await deps.governance.summary({ kind: 'project', id: projectId }, month)); return true
    }
    const requested = query.get('userId')
    if (requested !== null) {
      const userId = Number(requested); if (await deps.users.getById(userId) === null) { sendError(res, 404, 'user not found'); return true }
      sendJson(res, 200, await deps.governance.summary({ kind: 'user', id: userId }, month)); return true
    }
    const summaries = await Promise.all((await deps.users.list()).map(async user => ({
      userId: user.id,
      username: user.username,
      ...await deps.governance!.summary({ kind: 'user', id: user.id }, month),
    })))
    sendJson(res, 200, summaries)
    return true
  }

  if (pathname === '/admin/api/project-directories') {
    if (method !== 'GET') return false
    const requestedPath = new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? undefined
    const [projects, users] = await Promise.all([deps.projects.list(), deps.users.list()])
    sendJson(res, 200, listProjectDirectories(
      deps.cfg,
      requestedPath,
      [...projects.map(project => project.path), ...users.map(user => user.homePath)],
    ))
    return true
  }

  if (pathname === '/admin/api/projects') {
    if (method === 'GET') {
      const source = new URL(req.url ?? '/', 'http://x').searchParams.get('origin')
      if (source !== null && source !== 'admin' && source !== 'user') { sendError(res, 400, 'invalid origin'); return true }
      const projects = await deps.projects.list()
      sendJson(res, 200, source === null ? projects : projects.filter(project => project.origin === source))
      return true
    }
    if (method === 'POST') {
      const input = parseObject(body)
      const name = str(input, 'name')
      const path = str(input, 'path')
      if (name === undefined) { sendError(res, 400, 'name required'); return true }
      const project = await deps.projects.create({ name, path, createdBy: admin.id })
      await write('admin.projects.create', { id: project.id, name, path: project.path })
      sendJson(res, 200, project)
      return true
    }
    return false
  }

  const member = /^\/admin\/api\/projects\/(\d+)\/members\/(\d+)$/.exec(pathname)
  if (member !== null) {
    const projectId = Number(member[1])
    const userId = Number(member[2])
    if (await deps.projects.getById(projectId) === null) { sendError(res, 404, 'project not found'); return true }
    if (await deps.users.getById(userId) === null) { sendError(res, 404, 'user not found'); return true }
    if (method === 'PUT') {
      const mode = str(parseObject(body), 'mode')
      if (mode !== 'ro' && mode !== 'rw') { sendError(res, 400, 'invalid mode'); return true }
      await deps.projects.setMember(projectId, userId, mode as GrantMode)
      await write('admin.members.set', { projectId, userId, mode })
      await apply(userId)
      sendNoContent(res)
      return true
    }
    if (method === 'DELETE') {
      await deps.projects.removeMember(projectId, userId)
      await write('admin.members.remove', { projectId, userId })
      await apply(userId)
      sendNoContent(res)
      return true
    }
    return false
  }

  const projectIdPath = /^\/admin\/api\/projects\/(\d+)$/.exec(pathname)
  if (projectIdPath !== null) {
    const projectId = Number(projectIdPath[1])
    const project = await deps.projects.getById(projectId)
    if (project === null) { sendError(res, 404, 'project not found'); return true }
    if (method === 'GET') { sendJson(res, 200, project); return true }
    if (method === 'PATCH') {
      const name = str(parseObject(body), 'name')
      if (name === undefined) { sendError(res, 400, 'name required'); return true }
      await deps.projects.rename(projectId, name)
      await write('admin.projects.rename', { id: projectId, name })
      sendNoContent(res)
      return true
    }
    if (method === 'DELETE') {
      const userIds = await deps.instances.withStopped(
        { kind: 'project', id: projectId },
        async () => deps.projects.remove(projectId),
      )
      await write('admin.projects.delete', { id: projectId })
      for (const userId of userIds) await apply(userId)
      sendNoContent(res)
      return true
    }
    return false
  }

  if (pathname === '/admin/api/audit') {
    if (method !== 'GET') return false
    const q = new URL(req.url ?? '/', 'http://x').searchParams
    const num = (key: string): number | undefined => {
      const raw = q.get(key)
      if (raw === null || raw === '') return undefined
      const n = Number(raw)
      return Number.isFinite(n) ? n : undefined
    }
    const action = q.get('action')
    const actionPrefix = q.get('actionPrefix')
    const rows = (await deps.audit.query({
      userId: num('userId'),
      action: action !== null && action !== '' ? action : undefined,
      actionPrefix: actionPrefix !== null && actionPrefix !== '' ? actionPrefix : undefined,
      fromMs: num('from') ?? num('fromMs'),
      toMs: num('to') ?? num('toMs'),
      limit: num('limit'),
      offset: num('offset'),
    })).map(r => ({
      id: r.id, ts: r.ts, userId: r.userId, action: r.action, methodPath: r.methodPath, status: r.status, ip: r.ip,
    }))
    sendJson(res, 200, rows)
    return true
  }

  return false
}
