/** Administrator-qualified personal archive reads with generation-owned Runtime leases. @module */
import type { GatewayConfig } from './config.ts'
import type { GatewayUserService, GatewayProjectService } from './services.ts'
import type { InstanceManager, RuntimeSubject, RuntimeTarget } from './instances.ts'
import { RuntimeLeaseUnavailableError } from './instances.ts'
import { CollaborationDeniedError } from './collaboration.ts'
import { PRINCIPAL_HEADER, type GatewayPrincipalSigner, type PrincipalScope } from './principal.ts'
import { readResponseJson, ResponseBodyTooLargeError } from './response-budget.ts'
import type { ConversationArchiveRuntimeRead, ConversationArchiveRuntimeReader } from './postgres/conversation-archive-service.ts'

interface Dependencies {
  readonly cfg: Pick<GatewayConfig, 'readinessTimeoutMs' | 'upstreamResponseLimitBytes'>
  readonly users: Pick<GatewayUserService, 'getById'>
  readonly projects: Pick<GatewayProjectService, 'getById'>
  readonly instances: Pick<InstanceManager, 'ensureRunning' | 'operationRef'>
  readonly principals: GatewayPrincipalSigner
  readonly authorizeAdministrator: (administratorUserId: number) => Promise<void>
}

function archiveReadPayload(value: unknown): ConversationArchiveRuntimeRead {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('runtime archive reader returned invalid JSON')
  }
  const payload = value as { title?: unknown; descendants?: unknown; events?: unknown; hasMore?: unknown }
  if ((payload.title !== undefined && typeof payload.title !== 'string')
    || !Array.isArray(payload.descendants) || !Array.isArray(payload.events) || typeof payload.hasMore !== 'boolean') {
    throw new Error('runtime archive reader returned invalid archive page')
  }
  const descendants = payload.descendants.map(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('runtime archive reader returned invalid descendant')
    const row = item as { sessionId?: unknown; parentSessionId?: unknown; title?: unknown }
    if (typeof row.sessionId !== 'string' || row.sessionId === ''
      || (row.parentSessionId !== null && typeof row.parentSessionId !== 'string')
      || typeof row.title !== 'string') throw new Error('runtime archive reader returned invalid descendant')
    return { sessionId: row.sessionId, parentSessionId: row.parentSessionId, title: row.title }
  })
  const events = payload.events.map(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('runtime archive reader returned invalid event')
    const row = item as { sessionId?: unknown; seq?: unknown; type?: unknown; time?: unknown; data?: unknown }
    if (typeof row.sessionId !== 'string' || row.sessionId === '' || typeof row.type !== 'string' || row.type === ''
      || typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 0
      || typeof row.time !== 'number' || !Number.isSafeInteger(row.time) || row.time < 0) {
      throw new Error('runtime archive reader returned invalid event')
    }
    return { sessionId: row.sessionId, seq: row.seq, type: row.type, time: row.time, data: row.data }
  })
  return {
    ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
    descendants,
    events,
    hasMore: payload.hasMore,
  }
}


/**
 * Bind current administrator identity to Runtime startup, its read principal and the complete generation-owned operation.
 * @param deps - node-local account/project owners, Runtime supervisor and current administrator authority.
 * @returns a bounded reader; supplied administrators are rechecked after readiness and operation-lease admission.
 */
export function createArchiveRuntimeReader(deps: Dependencies): ConversationArchiveRuntimeReader {
  const { cfg, users, projects, instances } = deps
  return async (runtime, rootSessionId, fromSeq, limit, administratorUserId) => {
    let subject: RuntimeSubject
    let scope: PrincipalScope
    if (runtime.kind === 'user') {
      const user = await users.getById(runtime.id)
      if (user === null) return undefined
      subject = { ...user, runtimeId: runtime.runtimeId }
      scope = { kind: 'personal' }
    } else {
      const project = await projects.getById(runtime.id)
      if (project === null) return undefined
      subject = { kind: 'project', id: project.id, name: project.name, path: project.path, runtimeId: runtime.runtimeId }
      scope = { kind: 'project', projectId: project.id, projectName: project.name, mode: 'ro' }
    }
    const administrator = administratorUserId === undefined ? undefined : await users.getById(administratorUserId)
    if (administrator === null) throw new CollaborationDeniedError('forbidden')
    const running = await instances.ensureRunning(subject, 'passive', administratorUserId)
    const assertion = deps.principals.issue({
      user: administrator ?? {
        id: 1,
        username: 'gateway-archive-reader',
        displayName: 'Gateway archive reader',
        role: 'admin',
        status: 'active',
        homePath: '/',
        mustChangePassword: false,
        autoReviewEligible: false,
      },
      scope,
      runtime: { kind: runtime.kind, id: runtime.id, generation: running.generation,
        ...(running.runtimeId === undefined ? {} : { runtimeId: running.runtimeId }) },
      purpose: 'archive-read',
    })
    const authority = `127.0.0.1:${String(running.port)}`
    const target: RuntimeTarget = { kind: runtime.kind, id: runtime.id, runtimeId: running.runtimeId }
    try {
      await instances.operationRef(target, 1, running.generation)
    } catch (error) {
      if (error instanceof RuntimeLeaseUnavailableError) {
        throw new Error('runtime archive reader lost its operation lease; retry the archive request', { cause: error })
      }
      throw error
    }
    let failure: unknown
    try {
      if (administratorUserId !== undefined) await deps.authorizeAdministrator(administratorUserId)
      const response = await fetch(
        `http://${authority}/api/internal/archive/read?sessionId=${encodeURIComponent(rootSessionId)}&fromSeq=${String(fromSeq)}&limit=${String(limit)}`,
        { headers: { host: authority, [PRINCIPAL_HEADER]: assertion }, signal: AbortSignal.timeout(cfg.readinessTimeoutMs) },
      )
      if (response.status === 404) return undefined
      let value: unknown
      try { value = await readResponseJson(response, cfg.upstreamResponseLimitBytes) } catch (error) {
        if (error instanceof ResponseBodyTooLargeError) throw new Error('runtime archive reader response is too large')
        throw new Error(`runtime archive reader returned HTTP ${String(response.status)}`)
      }
      if (!response.ok) throw new Error(`runtime archive reader returned HTTP ${String(response.status)}`)
      return archiveReadPayload(value)
    } catch (error) {
      failure = error
      throw error
    } finally {
      try { await instances.operationRef(target, -1, running.generation) } catch (error) {
        throw new AggregateError(failure === undefined ? [error] : [failure, error], 'runtime archive read lease cleanup failed')
      }
    }
  }
}
