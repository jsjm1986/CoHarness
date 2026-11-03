/** Authorized environment placement and local owner resolution shared by HTTP and WebSocket dispatch. */
import type { UserRow } from './auth.ts'
import { CollaborationDeniedError } from './collaboration.ts'
import { RuntimeCatalogError, type RuntimeCatalogEntry, type RuntimeId, type RuntimeNodeId } from './runtime-catalog.ts'
import type { GatewayRequestContext } from './server.ts'
import type { GatewayCollaborationService, GatewayInstanceService } from './services.ts'

/** URL selectors and the legacy scope cookie; all values originate at the HTTP parser. */
export interface RuntimeSelection {
  runtimeId: string | null
  target: string | null
  scopeCookie: string | undefined
}

/** Request context plus the cookie repair needed only by an invalid legacy selection. */
export interface ResolvedRuntimeRoute {
  context: GatewayRequestContext
  resetScope: boolean
}

/** Authorized metadata selection before local execution or remote forwarding. */
export interface RuntimePlacement {
  target: 'personal' | `project:${number}`
  local: boolean
  /** Absent only in standalone compositions without an organization directory. */
  environment?: RuntimeCatalogEntry
  resetScope: boolean
}

/** Invalid explicit legacy selector; explicit selections never fall back to the personal environment. */
export class InvalidRuntimeTargetError extends Error {
  constructor() { super('invalid-runtime-target'); this.name = 'InvalidRuntimeTargetError' }
}

/** Live local service references; dispatch observes current authorization providers. */
export interface LocalRuntimeServices {
  collaboration?: Pick<GatewayCollaborationService, 'projectForUser'>
  instances?: Pick<GatewayInstanceService, 'storageOf'>
}

/** Local project authority and canonical paths remain owned by existing Gateway services. */
export class LocalRuntimeAdapter {
  /**
   * @param services - live project metadata and current membership authority; collaboration may be absent in personal-only compositions.
   */
  constructor(private readonly services: LocalRuntimeServices) {}

  /**
   * Resolve the already authenticated account's local personal context without starting a process.
   * @param user - current authenticated account.
   * @param runtimeId - authorized local assignment; omission requires a unique local personal Runtime.
   * @returns its local owner and personal scope.
   */
  async personal(user: UserRow, runtimeId?: RuntimeId): Promise<GatewayRequestContext> {
    const storage = await this.services.instances?.storageOf?.({ kind: 'user', id: user.id, runtimeId })
    return { user, scope: { kind: 'personal' }, runtime: storage === undefined ? user : { ...user, ...storage } }
  }

  /**
   * Resolve a project only after current node-local membership and mount authorization.
   * @param user - current authenticated account.
   * @param projectId - parsed project number, never an environment or node identifier.
   * @returns authorized local context, or null when unavailable to this account and node.
   */
  async project(user: UserRow, projectId: number): Promise<GatewayRequestContext | null> {
    const project = await this.services.collaboration?.projectForUser(projectId, user.id)
    if (project === undefined || project === null) return null
    const steward = project.kind === 'steward'
    const scope = { kind: 'project' as const, projectId, projectName: project.name, mode: project.mode, canManage: project.canManage,
      ...(steward ? { steward: true } : {}), uiThemePolicy: project.uiThemePolicy }
    return { user, scope,
    runtime: { kind: 'project', id: projectId, name: project.name, path: project.path, steward } }
  }
}

/** Directory authority paired with the execution node that this local adapter actually owns. */
export interface RuntimeRoutingDirectory {
  localNodeId: RuntimeNodeId
  /** Returns metadata for the exact authorized environment, including remote placement. */
  catalog: {
    resolveForAccount(actor: UserRow, id: string): Promise<RuntimeCatalogEntry>
    resolveForOwner(actor: UserRow, owner: { kind: 'personal' | 'project'; id: number }): Promise<RuntimeCatalogEntry>
    resolveForLanding(actor: UserRow): Promise<RuntimeCatalogEntry>
  }
}

/** Directory placement is shared with forwarding; the local adapter owns only local dispatch. */
export class GatewayRuntimeRouter {
  /**
   * @param local - local account/project context provider; it never connects to another node.
   * @param directory - authorized environment metadata and actual local-node identity, when composed.
   */
  constructor(private readonly local: LocalRuntimeAdapter, private readonly directory?: RuntimeRoutingDirectory) {}

  /**
   * Resolve a browser entry without forcing a personal account to choose its execution process first.
   * Explicit selectors retain strict placement; an implicit ambiguous or unavailable legacy selection may use the authorized personal default.
   * @param user - current authenticated account.
   * @param selection - browser selectors and the legacy scope cookie.
   * @returns authorized entry metadata without contacting or starting any Runtime.
   */
  async landing(user: UserRow, selection: RuntimeSelection): Promise<RuntimePlacement> {
    if (selection.runtimeId !== null || selection.target !== null || this.directory === undefined) return this.placement(user, selection)
    try {
      return await this.placement(user, selection)
    } catch (error) {
      if (!(error instanceof RuntimeCatalogError) || (error.status !== 404 && error.code !== 'runtime-catalog/ambiguous-target')) throw error
      const environment = await this.directory.catalog.resolveForLanding(user)
      return { environment, target: 'personal', local: environment.node.id === this.directory.localNodeId,
        resetScope: selection.scopeCookie !== undefined && selection.scopeCookie !== 'personal' }
    }
  }

  /**
   * Resolve exact or existing owner selectors before contacting their computer.
   * @param user - current authenticated account.
   * @param selection - explicit request selectors and the existing scope cookie.
   * @returns authorized placement; only an inaccessible legacy cookie may be repaired to personal scope.
   */
  async placement(user: UserRow, selection: RuntimeSelection): Promise<RuntimePlacement> {
    if (selection.runtimeId !== null) {
      if (this.directory === undefined) throw new RuntimeCatalogError(503, 'runtime-catalog/unavailable')
      const environment = await this.directory.catalog.resolveForAccount(user, selection.runtimeId)
      const target = environment.owner.kind === 'personal' ? 'personal' : `project:${environment.owner.id}` as const
      if (selection.target !== null && selection.target !== target) throw new RuntimeCatalogError(400, 'runtime-catalog/target-mismatch')
      return { environment, target, local: environment.node.id === this.directory.localNodeId, resetScope: false }
    }
    let target: RuntimePlacement['target'] = 'personal', resetScope = false
    const raw = selection.target ?? selection.scopeCookie
    if (raw !== undefined && raw !== 'personal') {
      const match = /^project:([1-9][0-9]*)$/u.exec(raw)
      const id = match === null ? NaN : Number(match[1])
      if (!Number.isSafeInteger(id)) {
        if (selection.target !== null) throw new InvalidRuntimeTargetError()
        resetScope = true
      } else target = `project:${id}`
    }
    if (this.directory === undefined) return { target, resetScope, local: true }
    const owner = target === 'personal' ? { kind: 'personal' as const, id: user.id }
      : { kind: 'project' as const, id: Number(target.slice('project:'.length)) }
    try {
      const environment = await this.directory.catalog.resolveForOwner(user, owner)
      return { target, resetScope, environment, local: environment.node.id === this.directory.localNodeId }
    } catch (error) {
      if (!(error instanceof RuntimeCatalogError) || error.code !== 'runtime-catalog/not-found' || target === 'personal') throw error
      if (selection.target !== null) throw new CollaborationDeniedError('not-member')
      const environment = await this.directory.catalog.resolveForOwner(user, { kind: 'personal', id: user.id })
      return { target: 'personal', resetScope: true, environment, local: environment.node.id === this.directory.localNodeId }
    }
  }

  /**
   * Resolve placement before invoking local lifecycle, policy projection or proxy handlers.
   * @param user - authenticated account; explicit environment access is rechecked by the directory.
   * @param selection - URL selection and optional legacy cookie.
   * @returns one authorized local context; a cookie may be repaired, while an explicit target never falls back.
   * @throws RuntimeCatalogError for unavailable, inaccessible, mismatched or remote environments.
   * @throws InvalidRuntimeTargetError for malformed explicit legacy targets.
   */
  async resolve(user: UserRow, selection: RuntimeSelection): Promise<ResolvedRuntimeRoute> {
    const placement = await this.placement(user, selection), { environment, target } = placement
    if (!placement.local) {
      throw new RuntimeCatalogError(503, 'runtime-catalog/remote-unavailable')
    }
    const context = target === 'personal' ? await this.local.personal(user, environment?.id) : await this.local.project(user, Number(target.slice('project:'.length)))
    if (context === null) {
      if (environment === undefined && selection.target === null) return { context: await this.local.personal(user), resetScope: true }
      throw new CollaborationDeniedError('not-member')
    }
    return { context: environment === undefined ? context : { ...context,
      runtime: { ...context.runtime, runtimeId: environment.id }, environment: { id: environment.id, nodeId: environment.node.id, nodeName: environment.node.name } },
      resetScope: placement.resetScope }
  }
}
