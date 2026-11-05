import { randomUUID } from 'node:crypto'
import { localProjectDisplays,type NodeProjectCreation,type ProjectContentRef } from '../node-content-projects.ts'
import { projectNamePolicy, reserveProjectName,withProjectNameProof,type ProjectNameMacAuthority, type ProjectNameRequest } from '../node-content-project-names.ts'
import { NodeContentUnavailable,type NodeContentBinding,type NodeContentStore } from '../node-content-store.ts'
import { realpathSync } from 'node:fs'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { CollaborationDeniedError } from '../collaboration.ts'
import type { GatewayConfig } from '../config.ts'
import { assertProjectImportPathAllowed } from '../project-directories.ts'
import {
  ensureManagedProjectDirectory,
  normalizeProjectName,
  projectPathsOverlap,
  resolveProjectDirectory,
  type EffectiveGrant,
  type GrantMode,
  type ProjectDetail,
  type ProjectInvitation,
  type ProjectInvitationStatus,
  type ProjectKind,
  type ProjectOrigin,
  type ProjectThemePolicy,
  type ProjectRow,
  type UserProjectMembership,
} from '../projects.ts'
import { transaction, type Queryable } from './database.ts'
import { allocateInstancePorts } from './port-allocation.ts'
import { lockProjectManagement } from './project-management-authority.ts'
import { lockAdministrator } from './administrator-authority.ts'
import {
  internalProjectId,
  internalUserId,
  publicNumber,
  type PostgresRuntimeContext,
} from './runtime-context.ts'

function isCodedError(error: unknown): error is Error & { code: string; constraint?: string } {
  return error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'
}

function realpathIfPresent(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch (error) {
    if (isCodedError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    throw error
  }
}

function managedSlug(name: string): string {
  return normalizeProjectName(name).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'project'
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

interface InvitationSelectRow {
  content:NodeContentBinding|null
  id: string
  project_public_id: string
  project_name: string
  invitee_public_id: string
  invitee_username: string
  invitee_display_name: string
  inviter_public_id: string
  inviter_username: string
  inviter_display_name: string
  mode: GrantMode
  status: ProjectInvitationStatus
  expires_at: Date | null
  created_at: Date
  responded_at: Date | null
}

/** PostgreSQL-backed project catalog and node-local mounts for one organization. */
export class PostgresProjectService {
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly cfg: GatewayConfig,
    private readonly entryNodeId?: string,
    private readonly placement?:NodeProjectCreation,
  ) {}

  /** Serialize new operational relationships with account deletion before taking project/link locks. */
  private async mutationUser(client: PoolClient, publicId: number): Promise<string | null> {
    const result = await client.query<{ id: string }>(`SELECT id FROM harness.users
      WHERE organization_id=$1 AND public_id=$2 AND deleted_at IS NULL FOR SHARE`, [this.context.organizationId, publicId])
    return result.rows[0]?.id ?? null
  }

  /** Retain active account/membership rows and any required administrator role; unavailable actors are forbidden. */
  private async activeMutationUser(
    client: PoolClient, publicId: number, purpose: 'actor' | 'recipient', requiredRole: 'member' | 'administrator' = 'member',
  ): Promise<string> {
    const user = await this.mutationUser(client, publicId)
    if (user === null) {
      if (purpose === 'actor') throw new CollaborationDeniedError('forbidden')
      throw new Error(`unknown user ${String(publicId)}`)
    }
    const authority = await client.query<{ user_status: string; membership_status: string; role: 'admin' | 'member' }>(`SELECT
      u.status user_status,m.status membership_status,m.role FROM harness.users u
      JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
      WHERE u.organization_id=$1 AND u.id=$2 FOR SHARE OF m`, [this.context.organizationId, user])
    const current = authority.rows[0]
    if (current === undefined || current.user_status !== 'active' || current.membership_status !== 'active'
      || requiredRole === 'administrator' && current.role !== 'admin') {
      if (purpose === 'actor') throw new CollaborationDeniedError('forbidden')
      throw new Error('user-disabled')
    }
    return user
  }

  /** Read organization availability after the transaction's project or allocation wait. */
  private async assertOrganizationActive(client: PoolClient): Promise<void> {
    if ((await client.query("SELECT 1 FROM harness.organizations WHERE id=$1 AND status='active'",
      [this.context.organizationId])).rowCount !== 1) throw new CollaborationDeniedError('forbidden')
  }

  /** Retain an account's permission on the project's fixed computer until the invitation transaction commits. */
  private async lockInvitationComputer(client: PoolClient, projectId: string, userId: string,
    denial: 'forbidden' | 'invitation-computer-required' = 'invitation-computer-required'): Promise<void> {
    const permission = await client.query(`SELECT permission.node_id FROM harness.instances instance
      JOIN harness.computer_use_permissions permission ON permission.organization_id=instance.organization_id
        AND permission.node_id=instance.assigned_node_id AND permission.user_id=$3
      WHERE instance.organization_id=$1 AND instance.project_id=$2 AND permission.enabled
        AND harness.computer_use_allowed(instance.organization_id,$3,instance.assigned_node_id)
        AND ($4::uuid IS NULL OR harness.entry_node_visible(instance.organization_id,$4,instance.assigned_node_id))
      FOR SHARE OF permission`, [this.context.organizationId, projectId, userId, this.entryNodeId ?? null])
    if (permission.rowCount !== 1) throw new CollaborationDeniedError(denial)
  }

  /** Import or allocate with current administrator authority; actor omission permits trusted internal maintenance. */
  async create(input: { name: string; path?: string; createdBy: number; actorUserId?: number },nameAuthority?:ProjectNameMacAuthority): Promise<ProjectRow> {
    if (input.actorUserId !== undefined && input.createdBy !== input.actorUserId) throw new CollaborationDeniedError('forbidden')
    const requestedPath = input.path?.trim()
    const name = normalizeProjectName(input.name)
    return this.insert({
      name,
      resolveDirectory: () => requestedPath === undefined || requestedPath === ''
        ? ensureManagedProjectDirectory(this.cfg, name).path : resolveProjectDirectory(requestedPath),
      createdBy: input.createdBy,
      origin: 'admin',
      ownerUserId: null,
      actorUserId: input.actorUserId,
    },nameAuthority)
  }

  /** Allocate a self-owned authenticated project, or trusted internal maintenance when actorUserId is omitted; preserve uncertain commits. */
  async createManaged(input: { name: string; ownerUserId: number; createdBy?: number; actorUserId?: number },nameAuthority?:ProjectNameMacAuthority): Promise<ProjectRow> {
    if (input.actorUserId !== undefined && (input.actorUserId !== input.ownerUserId
      || input.createdBy !== undefined && input.createdBy !== input.actorUserId)) throw new CollaborationDeniedError('forbidden')
    const name = normalizeProjectName(input.name)
    await mkdir(this.cfg.userProjectsRoot, { recursive: true, mode: 0o770 })
    let canonical: string | undefined
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = join(this.cfg.userProjectsRoot, `${managedSlug(name)}-${randomUUID().slice(0, 12)}`)
      try {
        await mkdir(candidate, { mode: 0o770 })
        canonical = await realpath(candidate)
        break
      } catch (error) {
        if (isCodedError(error) && error.code === 'EEXIST') continue
        throw error
      }
    }
    if (canonical === undefined) throw new Error('managed project directory allocation failed')
    return this.insert({
      name,
      resolveDirectory: () => canonical,
      createdBy: input.createdBy ?? input.ownerUserId,
      origin: 'user',
      ownerUserId: input.ownerUserId,
      allocatedDirectory: canonical,
      actorUserId: input.actorUserId,
    },nameAuthority)
  }

  private async insert(input: {
    name: string
    resolveDirectory: () => string
    createdBy: number | null
    origin: ProjectOrigin
    ownerUserId: number | null
    kind?: ProjectKind
    allocatedDirectory?: string
    actorUserId?: number
  },nameAuthority?:ProjectNameMacAuthority): Promise<ProjectRow> {
    const projectId=randomUUID()
    let commitMayHaveSucceeded = false
    let candidate:{store:NodeContentStore;runtimeId:import('../runtime-catalog.ts').RuntimeId}|undefined
    try {
      const publicId = await withProjectNameProof(this.context.pool,nameAuthority,async (client,identify) => {
        if (input.actorUserId !== undefined) {
          const actor = await this.activeMutationUser(client, input.actorUserId, 'actor',
            input.origin === 'admin' ? 'administrator' : 'member')
          if (input.origin === 'user' && (await client.query(`SELECT 1 FROM harness.computer_use_permissions
            WHERE organization_id=$1 AND user_id=$2 AND node_id=$3 AND enabled
              AND harness.computer_use_allowed($1,$2,$3) FOR SHARE`,
          [this.context.organizationId, actor, this.context.nodeId])).rowCount !== 1) throw new CollaborationDeniedError('forbidden')
        }
        const createdBy = input.createdBy === null
          ? null
          : await this.mutationUser(client, input.createdBy)
        if (createdBy === null && input.createdBy !== null) throw new Error(`unknown user ${String(input.createdBy)}`)
        const owner = input.ownerUserId === null
          ? null
          : await this.mutationUser(client, input.ownerUserId)
        if (input.ownerUserId !== null && owner === null) throw new Error(`unknown user ${String(input.ownerUserId)}`)
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-port:${this.context.nodeId}`])
        if (input.actorUserId !== undefined) await this.assertOrganizationActive(client)
        const canonical = input.resolveDirectory()
        await this.assertNotReserved(client, canonical, input.origin === 'user')
        const names=await projectNamePolicy(client,this.context.organizationId)
        const request:ProjectNameRequest={organizationId:this.context.organizationId,nodeId:this.context.nodeId,projectId,actorUserId:input.actorUserId,operation:'create',name:input.name}
        if (names && !nameAuthority) throw new NodeContentUnavailable('Project creation requires verification from the primary entry.')
        const proof=names ? identify(request) : undefined
        const selected=input.kind==='steward'?undefined:this.placement?.publication
        const publication=typeof selected==='function'?selected():selected
        const physical=publication && !publication.missing().length
        if (input.kind!=='steward' && this.placement?.requirePhysical && !physical) throw new NodeContentUnavailable('The selected computer has incomplete project content services.')
        if (physical && (!proof || names?.state!=='active' || !this.placement?.ready)) throw new NodeContentUnavailable('Project storage and organization name verification must be ready on the primary.')
        const store=physical?await this.placement!.ready!():undefined
        const alias='hgw-project-'+projectId
        const project = await client.query<{ id: string; public_id: string }>(`INSERT INTO harness.projects(
          organization_id,name,created_by,origin,owner_user_id,model_access_default_allowed,kind,id
        ) VALUES($1,$2,$3,$4,$5,true,$6,$7) RETURNING id,public_id::text`, [
          this.context.organizationId, store?alias:input.name, createdBy, input.origin, owner, input.kind ?? 'standard',projectId,
        ])
        const row = project.rows[0]
        if (row === undefined) throw new Error('project insert returned no row')
        await client.query(`INSERT INTO harness.project_mounts(
          organization_id,project_id,node_id,local_path,canonical_path
        ) VALUES($1,$2,$3,$4,$4)`, [this.context.organizationId, row.id, this.context.nodeId,store?'urn:hgw:project:'+projectId:canonical])
        if (proof) await reserveProjectName(client,request,proof)
        // The steward space keeps an empty member list: admission comes from
        // the steward qualification lane, so no creator row is written.
        const member = input.kind === 'steward' ? null : owner ?? createdBy
        if (member !== null) await client.query(`INSERT INTO harness.project_members(
          organization_id,project_id,user_id,access_mode
        ) VALUES($1,$2,$3,'rw')`, [this.context.organizationId, row.id, member])
        const [port] = await allocateInstancePorts(
          client,
          this.context.nodeId,
          this.cfg.instancePortBase,
          1,
          this.context.nodeName,
        )
        const allocation=await client.query<{runtime_id:import('../runtime-catalog.ts').RuntimeId}>(`INSERT INTO harness.instances(
          organization_id,project_id,assigned_node_id,port
        ) VALUES($1,$2,$3,$4) RETURNING runtime_id`, [this.context.organizationId, row.id, this.context.nodeId, port])
        if (store && publication) {
          candidate={store,runtimeId:allocation.rows[0]!.runtime_id}
          await store.bindNewProject(client,{projectId:row.id,runtimeId:candidate.runtimeId,name:input.name,rootPath:canonical},publication)
        }
        const id = publicNumber(row.public_id, 'project')
        // A lost COMMIT acknowledgement leaves ownership unknown; response reads cannot undo the mount.
        commitMayHaveSucceeded = true
        return id
      })
      const detail = await this.getById(publicId)
      if (detail === null) throw new Error('project insert returned no detail')
      return detail
    } catch (error) {
      // Preserve the imported directory and inert candidate if ownership cannot be confirmed after a failed commit.
      const detached=candidate===undefined?false:await candidate.store.discardDetachedCreation(this.context.pool,projectId,candidate.runtimeId).catch(()=>false)
      if (input.allocatedDirectory !== undefined && (!commitMayHaveSucceeded||detached)) {
        await rm(input.allocatedDirectory, { recursive: true, force: true })
      }
      if (isCodedError(error) && error.code === '23505') {
        if (error.constraint === 'project_name_claims_organization_id_key_id_mac_key') throw new Error('duplicate project name')
        if (error.constraint === 'projects_organization_id_name_key') throw new Error(`duplicate project name: ${input.name}`)
        if (error.constraint === 'project_mounts_node_id_canonical_path_key') throw new Error('project-path-overlap')
        throw new Error(`duplicate project: ${error.message}`)
      }
      throw error
    }
  }

  /**
   * Seed the reserved steward space, or return the existing row. The caller
   * provisions the workspace directory first so the mount records a canonical
   * path that already exists on this node.
   */
  async ensureSteward(input: { name: string; path: string; createdBy?: number }): Promise<ProjectRow> {
    const existing = await this.stewardProject()
    if (existing !== null) {
      const detail = await this.getById(existing.id)
      if (detail !== null) return detail
    }
    const name = normalizeProjectName(input.name)
    const canonical = resolveProjectDirectory(input.path)
    try {
      return await this.insert({
        name,
        resolveDirectory: () => canonical,
        createdBy: input.createdBy ?? null,
        origin: 'admin',
        ownerUserId: null,
        kind: 'steward',
      })
    } catch (error) {
      // A name collision with an administrator-created project must not block
      // seeding; fall back to a suffixed reserved name once.
      if (error instanceof Error && error.message.startsWith('duplicate project name')) {
        return this.insert({
          name: normalizeProjectName(`${name}-steward`),
          resolveDirectory: () => canonical,
          createdBy: input.createdBy ?? null,
          origin: 'admin',
          ownerUserId: null,
          kind: 'steward',
        })
      }
      throw error
    }
  }

  /** Current steward project target visible on this node, when seeded. */
  async stewardProject(): Promise<{ id: number; name: string; path: string } | null> {
    const result = await this.context.pool.query<{ public_id: string; name: string; path: string }>(
      `SELECT p.public_id::text,p.name::text,pm.local_path path
      FROM harness.projects p
      JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
        AND pm.node_id=$2 AND pm.status='active'
      WHERE p.organization_id=$1 AND p.kind='steward' AND p.status='active'
      ORDER BY p.public_id LIMIT 1`,
      [this.context.organizationId, this.context.nodeId],
    )
    const row = result.rows[0]
    return row === undefined ? null : { id: publicNumber(row.public_id, 'project'), name: row.name, path: row.path }
  }

  /** Reserved kind of a project by internal row id, or null when unknown. */
  async kindOfInternal(internalId: string): Promise<ProjectKind | null> {
    const result = await this.context.pool.query<{ kind: ProjectKind }>(
      'SELECT kind FROM harness.projects WHERE organization_id=$1 AND id=$2',
      [this.context.organizationId, internalId],
    )
    return result.rows[0]?.kind ?? null
  }

  /** Refuse mutations that would break the reserved steward space. */
  private async assertNotSteward(queryable: Queryable, projectInternalId: string | null): Promise<void> {
    if (projectInternalId === null) return
    const result = await queryable.query<{ kind: ProjectKind }>(
      'SELECT kind FROM harness.projects WHERE organization_id=$1 AND id=$2',
      [this.context.organizationId, projectInternalId],
    )
    if (result.rows[0]?.kind === 'steward') throw new CollaborationDeniedError('steward-reserved')
  }

  async list(display?: 'directory'): Promise<ProjectRow[]> {
    const result = await this.context.pool.query<{
      public_id: string
      content:NodeContentBinding|null
      name: string
      path: string
      member_count: string
      origin: ProjectOrigin
      kind: ProjectKind
      model_access_default_allowed: boolean
      ui_theme_policy: ProjectThemePolicy
      owner_id: string | null
      owner_public_id: string | null
      owner_username: string | null
      owner_display_name: string | null
      creator_public_id: string | null
      creator_username: string | null
      creator_display_name: string | null
    }>(`SELECT p.public_id::text,p.name::text,pm.local_path path,harness.project_content_key(p.organization_id,p.id) content,COUNT(m.user_id)::text member_count,
      p.origin,p.kind,p.model_access_default_allowed,p.ui_theme_policy,
      owner.id owner_id,owner.public_id::text owner_public_id,owner.username::text owner_username,owner.display_name owner_display_name,
      creator.public_id::text creator_public_id,creator.username::text creator_username,creator.display_name creator_display_name
      FROM harness.projects p
      JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
        AND pm.node_id=$2 AND pm.status='active'
      LEFT JOIN harness.project_members m ON m.project_id=p.id AND m.organization_id=p.organization_id
      LEFT JOIN harness.users owner ON owner.id=p.owner_user_id AND owner.organization_id=p.organization_id
      LEFT JOIN harness.users creator ON creator.id=p.created_by AND creator.organization_id=p.organization_id
      WHERE p.organization_id=$1 AND p.status='active'
      GROUP BY p.id,pm.local_path,owner.id,creator.id ORDER BY p.public_id`, [this.context.organizationId, this.context.nodeId])
    const metadata = display === 'directory' ? undefined : await localProjectDisplays(this.placement?.metadata, result.rows)
    return result.rows.map(row => ({
      id: publicNumber(row.public_id, 'project'),
      ...(row.content ? { metadataOnNode: true as const, nodeId: row.content.nodeId as NonNullable<ProjectRow['nodeId']>, runtimeId: row.content.runtimeId } : {}),
      name: row.content ? display === 'directory' ? `#${row.public_id}` : metadata!.get(row.content.projectId)!.name : row.name,
      path: row.content ? display === 'directory' ? '' : metadata!.get(row.content.projectId)!.rootPath : row.path,
      memberCount: Number(row.member_count),
      origin: row.origin,
      kind: row.kind,
      modelAccessDefaultAllowed: row.model_access_default_allowed,
      uiThemePolicy: row.ui_theme_policy,
      owner: row.owner_id === null ? null : {
        id: publicNumber(row.owner_public_id!, 'user'), username: row.owner_username!, displayName: row.owner_display_name!,
      },
      createdBy: row.creator_public_id === null ? null : {
        id: publicNumber(row.creator_public_id, 'user'), username: row.creator_username!, displayName: row.creator_display_name!,
      },
    }))
  }

  async getByIds(ids: readonly number[], display?: 'directory'): Promise<ProjectDetail[]> {
    const uniqueIds = [...new Set(ids)]
    if (uniqueIds.length === 0) return []
    const project = await this.context.pool.query<{
      internal_id: string
      public_id: string
      content:NodeContentBinding|null
      name: string
      path: string
      member_count: string
      origin: ProjectOrigin
      kind: ProjectKind
      model_access_default_allowed: boolean
      ui_theme_policy: ProjectThemePolicy
      owner_id: string | null
      owner_public_id: string | null
      owner_username: string | null
      owner_display_name: string | null
      creator_public_id: string | null
      creator_username: string | null
      creator_display_name: string | null
    }>(`SELECT p.id internal_id,p.public_id::text,p.name::text,pm.local_path path,harness.project_content_key(p.organization_id,p.id) content,
      COUNT(m.user_id)::text member_count,p.origin,p.kind,p.model_access_default_allowed,p.ui_theme_policy,
      owner.id owner_id,owner.public_id::text owner_public_id,owner.username::text owner_username,owner.display_name owner_display_name,
      creator.public_id::text creator_public_id,creator.username::text creator_username,creator.display_name creator_display_name
      FROM harness.projects p
      JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
        AND pm.node_id=$2 AND pm.status='active'
      LEFT JOIN harness.project_members m ON m.project_id=p.id AND m.organization_id=p.organization_id
      LEFT JOIN harness.users owner ON owner.id=p.owner_user_id AND owner.organization_id=p.organization_id
      LEFT JOIN harness.users creator ON creator.id=p.created_by AND creator.organization_id=p.organization_id
      WHERE p.organization_id=$1 AND p.public_id=ANY($3::bigint[]) AND p.status='active'
      GROUP BY p.id,pm.local_path,owner.id,creator.id ORDER BY p.public_id`, [this.context.organizationId, this.context.nodeId, uniqueIds])
    if (project.rows.length === 0) return []
    const members = await this.context.pool.query<{
      project_id: string
      user_id: string
      username: string
      access_mode: GrantMode
    }>(`SELECT m.project_id::text project_id,u.public_id::text user_id,u.username::text,m.access_mode
      FROM harness.project_members m
      JOIN harness.users u ON u.id=m.user_id AND u.organization_id=m.organization_id
      WHERE m.organization_id=$1 AND m.project_id=ANY($2::uuid[]) ORDER BY m.project_id,u.username`,
    [this.context.organizationId, project.rows.map(row => row.internal_id)])
    const membersByProject = new Map<string, Array<{ userId: number; username: string; mode: GrantMode }>>()
    for (const member of members.rows) {
      const list = membersByProject.get(member.project_id) ?? []
      list.push({ userId: publicNumber(member.user_id, 'user'), username: member.username, mode: member.access_mode })
      membersByProject.set(member.project_id, list)
    }
    const metadata = display === 'directory' ? undefined : await localProjectDisplays(this.placement?.metadata, project.rows)
    return project.rows.map(row => ({
      id: publicNumber(row.public_id, 'project'),
      ...(row.content ? { metadataOnNode: true as const, nodeId: row.content.nodeId as NonNullable<ProjectRow['nodeId']>, runtimeId: row.content.runtimeId } : {}),
      name: row.content ? display === 'directory' ? `#${row.public_id}` : metadata!.get(row.content.projectId)!.name : row.name,
      path: row.content ? display === 'directory' ? '' : metadata!.get(row.content.projectId)!.rootPath : row.path,
      memberCount: Number(row.member_count),
      origin: row.origin,
      kind: row.kind,
      modelAccessDefaultAllowed: row.model_access_default_allowed,
      uiThemePolicy: row.ui_theme_policy,
      owner: row.owner_id === null ? null : {
        id: publicNumber(row.owner_public_id!, 'user'), username: row.owner_username!, displayName: row.owner_display_name!,
      },
      createdBy: row.creator_public_id === null ? null : {
        id: publicNumber(row.creator_public_id, 'user'), username: row.creator_username!, displayName: row.creator_display_name!,
      },
      members: membersByProject.get(row.internal_id) ?? [],
    }))
  }

  async getById(id: number, display?: 'directory'): Promise<ProjectDetail | null> {
    return (await this.getByIds([id], display))[0] ?? null
  }

  /** Re-index a bounded page on the project computer without publishing its display names to the directory.
   * @param actorUserId - current administrator.
   * @param authority - primary signer bound to this request's verified credentials.
   * @param after - last completed public project id; zero starts from the beginning.
   * @param limit - maximum projects per call.
   * @returns live progress markers suitable for retry after an offline node or key rotation.
   */
  async reindexNames(actorUserId:number,authority:ProjectNameMacAuthority,after=0,limit=32):Promise<{indexed:number;next:number|null}> {
    if (!Number.isSafeInteger(after) || after<0 || !Number.isSafeInteger(limit) || limit<1 || limit>32) throw new Error('Invalid name index page.')
    const ids=await transaction(this.context.pool,async tx=>{
      await lockAdministrator(tx,this.context,actorUserId)
      if (!await projectNamePolicy(tx,this.context.organizationId)) throw new NodeContentUnavailable('No organization project name policy is configured.')
      return (await tx.query<{public_id:string}>(`SELECT p.public_id::text FROM harness.projects p JOIN harness.project_mounts m
        ON m.organization_id=p.organization_id AND m.project_id=p.id WHERE p.organization_id=$1 AND m.node_id=$2 AND p.status='active'
        AND p.public_id>$3 ORDER BY p.public_id LIMIT $4`,[this.context.organizationId,this.context.nodeId,after,limit+1])).rows.map(row=>publicNumber(row.public_id,'project'))
    })
    let indexed=0
    for (const id of ids.slice(0,limit)) {
      await withProjectNameProof(this.context.pool,authority,async (tx,identify)=>{
        await lockAdministrator(tx,this.context,actorUserId)
        const row=(await tx.query<{id:string;name:string;content:NodeContentBinding|null}>(`SELECT p.id,p.name::text,harness.project_content_key(p.organization_id,p.id) content
          FROM harness.projects p JOIN harness.project_mounts m ON m.organization_id=p.organization_id AND m.project_id=p.id WHERE p.organization_id=$1 AND m.node_id=$2
            AND p.public_id=$3 AND p.status='active' FOR UPDATE OF p FOR SHARE OF m`,[this.context.organizationId,this.context.nodeId,id])).rows[0]
        if (!row) return
        const display=await localProjectDisplays(this.placement?.metadata,[row])
        const request:ProjectNameRequest={organizationId:this.context.organizationId,nodeId:this.context.nodeId,projectId:row.id,actorUserId,
          name:row.content?display.get(row.id)!.name:row.name,operation:'reindex'}
        await reserveProjectName(tx,request,identify(request))
        indexed++
      })
    }
    return {indexed,next:ids.length>limit?ids[limit-1]!:null}
  }

  async rename(id: number, name: string, actorUserId?: number,nameAuthority?:ProjectNameMacAuthority): Promise<void> {
    const normalized = normalizeProjectName(name)
    try {
      await withProjectNameProof(this.context.pool,nameAuthority,async (client,identify) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['gateway-port:'+this.context.nodeId])
        const project = await lockProjectManagement(client, this.context, id, actorUserId)
        await this.assertNotSteward(client, project)
        const request:ProjectNameRequest={organizationId:this.context.organizationId,nodeId:this.context.nodeId,projectId:project,actorUserId,operation:'rename',name:normalized}
        const names=await projectNamePolicy(client,this.context.organizationId)
        if (names && !nameAuthority) throw new NodeContentUnavailable('Project rename requires verification from the primary entry.')
        const proof=names?identify(request):undefined
        const key=(await client.query<ProjectContentRef>('SELECT harness.project_content_key($1,$2) content',[this.context.organizationId,project])).rows[0]?.content
        if (key && (!this.placement || !proof)) throw new NodeContentUnavailable('Project name authority is unavailable.')
        if (key) await client.query('UPDATE harness.projects SET logical_name_revision=logical_name_revision+1,updated_at=now(),version=version+1 WHERE organization_id=$1 AND id=$2',[this.context.organizationId,project])
        else await client.query('UPDATE harness.projects SET name=$3,logical_name_revision=logical_name_revision+1,updated_at=now(),version=version+1 WHERE organization_id=$1 AND id=$2',[this.context.organizationId,project,normalized])
        if (proof) await reserveProjectName(client,request,proof)
        if (key) await this.placement!.metadata.rename(client,key,normalized)
      })
    } catch (error) {
      if (isCodedError(error) && error.code === '23505') throw new Error('duplicate project name')
      throw error
    }
  }

  /** Update the project UI theme policy without changing its filesystem identity. */
  async setThemePolicy(id: number, policy: ProjectThemePolicy, actorUserId?: number): Promise<void> {
    if (policy !== 'follow-user' && policy !== 'light' && policy !== 'dark') {
      throw new Error('invalid project theme policy')
    }
    await transaction(this.context.pool, async (client) => {
      const project = await lockProjectManagement(client, this.context, id, actorUserId)
      await client.query(`UPDATE harness.projects SET ui_theme_policy=$3,updated_at=now(),version=version+1
        WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, project, policy])
    })
  }

  async remove(id: number, actorUserId?: number): Promise<number[]> {
    return transaction(this.context.pool, async (client) => {
      if (actorUserId !== undefined) await lockProjectManagement(client, this.context, id, actorUserId, 'administrator')
      const selected = await client.query<{ id: string } & ProjectContentRef>(
        'SELECT id,harness.project_content_key(organization_id,id) content FROM harness.projects WHERE organization_id=$1 AND public_id=$2 FOR UPDATE',
        [this.context.organizationId, id])
      const projectId = selected.rows[0]?.id
      if (projectId === undefined) return []
      await this.assertNotSteward(client, projectId)
      const members = await client.query<{ public_id: string }>(`SELECT u.public_id::text
        FROM harness.project_members m
        JOIN harness.users u ON u.id=m.user_id AND u.organization_id=m.organization_id
        WHERE m.organization_id=$1 AND m.project_id=$2 ORDER BY u.public_id`,
      [this.context.organizationId, projectId])
      await client.query('DELETE FROM harness.model_runtime_intake_tokens WHERE organization_id=$1 AND project_id=$2',
        [this.context.organizationId, projectId])
      if (selected.rows[0]?.content) {
        await client.query("UPDATE harness.projects SET status='archived',updated_at=now(),version=version+1 WHERE organization_id=$1 AND id=$2",[this.context.organizationId,projectId])
        await client.query('DELETE FROM harness.project_name_claims WHERE organization_id=$1 AND project_id=$2',[this.context.organizationId,projectId])
        await client.query("UPDATE harness.project_invitations SET status='revoked',responded_at=now() WHERE organization_id=$1 AND project_id=$2 AND status='pending'",[this.context.organizationId,projectId])
        await client.query('DELETE FROM harness.project_members WHERE organization_id=$1 AND project_id=$2',[this.context.organizationId,projectId])
        await client.query('DELETE FROM harness.instances WHERE organization_id=$1 AND project_id=$2',[this.context.organizationId,projectId])
      } else await client.query('DELETE FROM harness.projects WHERE organization_id=$1 AND id=$2',[this.context.organizationId,projectId])
      return members.rows.map(row => publicNumber(row.public_id, 'user'))
    })
  }

  /** Set current membership and revoke pending invitations superseded by this decision. */
  async setMember(projectId: number, userId: number, mode: GrantMode, actorUserId?: number): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      const project = await internalProjectId(client, this.context.organizationId, projectId)
      const user = await this.mutationUser(client, userId)
      if (project === null) throw new Error(`unknown project ${String(projectId)}`)
      if (actorUserId !== undefined) await lockProjectManagement(client, this.context, projectId, actorUserId, 'administrator')
      await this.assertNotSteward(client, project)
      if (user === null) throw new Error(`unknown user ${String(userId)}`)
      const owner = await client.query<{ owner_user_id: string | null }>(
        'SELECT owner_user_id FROM harness.projects WHERE organization_id=$1 AND id=$2 FOR UPDATE',
        [this.context.organizationId, project],
      )
      const current = owner.rows[0]
      if (current === undefined) throw new Error(`unknown project ${String(projectId)}`)
      if (current.owner_user_id === user && mode !== 'rw') throw new Error('owner-must-be-rw')
      await client.query(`INSERT INTO harness.project_members(
        organization_id,project_id,user_id,access_mode
      ) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,user_id) DO UPDATE SET
        access_mode=excluded.access_mode,updated_at=now()`, [this.context.organizationId, project, user, mode])
      await client.query(`UPDATE harness.project_invitations SET status='revoked',responded_at=now()
        WHERE organization_id=$1 AND project_id=$2 AND invitee_user_id=$3 AND status='pending'`,
      [this.context.organizationId, project, user])
    })
  }

  /** Remove membership and revoke pending invitations, including for an account not yet enrolled. */
  async removeMember(projectId: number, userId: number, actorUserId?: number): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      const project = await internalProjectId(client, this.context.organizationId, projectId)
      const user = await this.mutationUser(client, userId)
      if (project !== null && actorUserId !== undefined) {
        await lockProjectManagement(client, this.context, projectId, actorUserId, 'administrator')
      }
      // A memberless steward row must still refuse the mutation rather than
      // reporting success for a membership that can never exist.
      await this.assertNotSteward(client, project)
      if (project === null) return
      const owner = await client.query<{ owner_user_id: string | null } & ProjectContentRef>(
        'SELECT owner_user_id,harness.project_content_key(organization_id,id) content FROM harness.projects WHERE organization_id=$1 AND id=$2 FOR UPDATE',
        [this.context.organizationId, project],
      )
      const membership = await client.query<{ project_id: string; user_id: string }>(`SELECT
        m.project_id,m.user_id
        FROM harness.project_members m
        JOIN harness.projects p ON p.id=m.project_id AND p.organization_id=m.organization_id
        JOIN harness.users u ON u.id=m.user_id AND u.organization_id=m.organization_id
        WHERE m.organization_id=$1 AND p.public_id=$2 AND u.public_id=$3
        FOR UPDATE OF m`, [this.context.organizationId, projectId, userId])
      const locked = membership.rows[0]
      if (locked === undefined) {
        if (user !== null) await client.query(`UPDATE harness.project_invitations SET status='revoked',responded_at=now()
          WHERE organization_id=$1 AND project_id=$2 AND invitee_user_id=$3 AND status='pending'`,
        [this.context.organizationId, project, user])
        return
      }
      if (owner.rows[0]?.owner_user_id === locked.user_id) throw new Error('owner-protected')
      const binding=owner.rows[0]?.content
      if (binding && !this.placement) throw new NodeContentUnavailable()
      const privateConversation = binding ? await this.placement!.metadata.hasPrivateRoots(binding,locked.user_id) : (await client.query<{ blocked: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM harness.conversation_sessions c
        WHERE c.organization_id=$1 AND c.project_id=$2 AND c.creator_user_id=$3
          AND c.id=c.root_session_id AND c.visibility='private' AND c.status<>'deleted'
      ) blocked`, [this.context.organizationId, locked.project_id, locked.user_id])).rows[0]?.blocked === true
      if (privateConversation) {
        throw new CollaborationDeniedError('visibility-locked')
      }
      await client.query(`DELETE FROM harness.project_members
        WHERE organization_id=$1 AND project_id=$2 AND user_id=$3`,
      [this.context.organizationId, locked.project_id, locked.user_id])
      await client.query(`UPDATE harness.project_invitations SET status='revoked',responded_at=now()
        WHERE organization_id=$1 AND project_id=$2 AND invitee_user_id=$3 AND status='pending'`,
      [this.context.organizationId, locked.project_id, locked.user_id])
    })
  }

  async membershipsFor(userId: number): Promise<UserProjectMembership[]> {
    const result = await this.context.pool.query<{
      content:NodeContentBinding|null
      public_id: string
      name: string
      path: string
      access_mode: GrantMode
    }>(`SELECT p.public_id::text,p.name::text,pm.local_path path,harness.project_content_key(p.organization_id,p.id) content,m.access_mode
      FROM harness.project_members m
      JOIN harness.projects p ON p.id=m.project_id AND p.organization_id=m.organization_id AND p.status='active'
      JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
        AND pm.node_id=$2 AND pm.status='active'
      JOIN harness.users u ON u.id=m.user_id AND u.organization_id=m.organization_id
      WHERE m.organization_id=$1 AND u.public_id=$3 ORDER BY p.name`,
    [this.context.organizationId, this.context.nodeId, userId])
    const metadata=await localProjectDisplays(this.placement?.metadata,result.rows)
    return result.rows.map(row => ({
      projectId: publicNumber(row.public_id, 'project'),
      name: row.content?metadata.get(row.content.projectId)!.name:row.name,
      path: row.content?metadata.get(row.content.projectId)!.rootPath:row.path,
      mode: row.access_mode,
    }))
  }

  /** Create a pending invitation, retiring an expired pending invitation for the same recipient. */
  async createInvitation(input: {
    projectId: number
    inviteeUserId: number
    inviterUserId: number
    mode: GrantMode
  }): Promise<ProjectInvitation> {
    try {
      const invitationId = await transaction(this.context.pool, async (client) => {
        const projectId = await internalProjectId(client, this.context.organizationId, input.projectId)
        if (projectId === null) throw new Error(`unknown project ${String(input.projectId)}`)
        const inviteeId = await this.activeMutationUser(client, input.inviteeUserId, 'recipient')
        const inviterId = await this.activeMutationUser(client, input.inviterUserId, 'actor')
        const selected = await client.query<{ status: string }>('SELECT status FROM harness.projects WHERE organization_id=$1 AND id=$2 FOR UPDATE',
          [this.context.organizationId, projectId])
        if (selected.rows[0] === undefined) throw new Error(`unknown project ${String(input.projectId)}`)
        if (selected.rows[0].status !== 'active') throw new CollaborationDeniedError('forbidden')
        await this.assertNotSteward(client, projectId)
        const authority = await client.query<{ role: 'admin' | 'member'; status: 'active' | 'disabled'; membership_status: 'active' | 'disabled'; owner_user_id: string | null }>(`SELECT
          m.role,u.status,m.status membership_status,p.owner_user_id
          FROM harness.users u
          JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
          JOIN harness.projects p ON p.organization_id=u.organization_id AND p.id=$3
          WHERE u.organization_id=$1 AND u.id=$2 FOR SHARE OF u,m`, [this.context.organizationId, inviterId, projectId])
        const authorityRow = authority.rows[0]
        if (authorityRow === undefined || authorityRow.status !== 'active' || authorityRow.membership_status !== 'active'
          || (authorityRow.role !== 'admin' && authorityRow.owner_user_id !== inviterId)) {
          throw new Error('invitation-forbidden')
        }
        await this.assertOrganizationActive(client)
        await this.lockInvitationComputer(client, projectId, inviterId, 'forbidden')
        await this.lockInvitationComputer(client, projectId, inviteeId)
        const existing = await client.query(`SELECT 1 FROM harness.project_members
          WHERE organization_id=$1 AND project_id=$2 AND user_id=$3`, [this.context.organizationId, projectId, inviteeId])
        if (existing.rowCount !== null && existing.rowCount > 0) throw new Error('invitation-already-member')
        await client.query(`UPDATE harness.project_invitations SET status='expired',responded_at=clock_timestamp()
          WHERE organization_id=$1 AND project_id=$2 AND invitee_user_id=$3
            AND status='pending' AND expires_at<=clock_timestamp()`, [this.context.organizationId, projectId, inviteeId])
        const row = await client.query<{ id: string }>(`INSERT INTO harness.project_invitations(
          organization_id,project_id,invitee_user_id,inviter_user_id,access_mode
        ) VALUES($1,$2,$3,$4,$5) RETURNING id::text`, [
          this.context.organizationId,
          projectId, inviteeId, inviterId,
          input.mode,
        ])
        const id = row.rows[0]?.id
        if (id === undefined) throw new Error('invitation insert returned no row')
        return id
      })
      return await this.invitationById(invitationId)
    } catch (error) {
      if (isCodedError(error) && error.code === '23505') throw new Error('invitation-already-pending')
      throw error
    }
  }

  /** Read a bounded recipient directory using current management and project-computer authority. */
  async listInvitableUsers(projectId: number, actorUserId: number, cursor = 0): Promise<{
    items: Array<{ id: number; username: string; displayName: string }>; nextCursor: number | null
  }> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('invalid-user-cursor')
    return transaction(this.context.pool, async client => {
      const project = await lockProjectManagement(client, this.context, projectId, actorUserId)
      await this.assertNotSteward(client, project)
      const limit = this.cfg.runtimeCatalog.pageSize
      const result = await client.query<{ id: string; username: string; display_name: string }>(`SELECT
        u.public_id::text id,u.username::text,u.display_name FROM harness.users u
        JOIN harness.instances instance ON instance.organization_id=u.organization_id AND instance.project_id=$2
        WHERE u.organization_id=$1 AND u.public_id>$3 AND u.public_id<>$4
          AND harness.computer_use_allowed(u.organization_id,u.id,instance.assigned_node_id)
          AND NOT EXISTS(SELECT 1 FROM harness.project_members member
            WHERE member.organization_id=u.organization_id AND member.project_id=$2 AND member.user_id=u.id)
        ORDER BY u.public_id LIMIT $5`, [this.context.organizationId, project, cursor, actorUserId, limit + 1])
      const items = result.rows.slice(0, limit).map(row => ({ id: publicNumber(row.id, 'user'),
        username: row.username, displayName: row.display_name }))
      const page = { items, nextCursor: result.rows.length > limit ? items.at(-1)!.id : null }
      if (Buffer.byteLength(JSON.stringify(page)) > this.cfg.runtimeCatalog.maxBytes) throw new Error('invitation-directory-too-large')
      return page
    })
  }

  async listInvitations(userId: number, projectId?: number): Promise<ProjectInvitation[]> {
    const internalUser = await internalUserId(this.context.pool, this.context.organizationId, userId)
    if (internalUser === null) return []
    const values: unknown[] = [this.context.organizationId, internalUser, this.entryNodeId ?? null]
    let projectClause = ''
    if (projectId !== undefined) {
      const internalProject = await internalProjectId(this.context.pool, this.context.organizationId, projectId)
      if (internalProject === null) return []
      values.push(internalProject)
      projectClause = ' AND i.project_id=$4'
    }
    const result = await this.context.pool.query<InvitationSelectRow>(`SELECT i.id::text id,
      p.public_id::text project_public_id,harness.project_content_key(p.organization_id,p.id) content,CASE WHEN harness.project_content_key(p.organization_id,p.id) IS NULL THEN p.name::text ELSE '#'||p.public_id::text END project_name,
      iu.public_id::text invitee_public_id,iu.username::text invitee_username,iu.display_name invitee_display_name,
      ru.public_id::text inviter_public_id,ru.username::text inviter_username,ru.display_name inviter_display_name,
      i.access_mode mode,CASE WHEN i.status='pending' AND i.expires_at<=clock_timestamp() THEN 'expired' ELSE i.status END status,
      i.expires_at,i.created_at,i.responded_at
      FROM harness.project_invitations i
      JOIN harness.projects p ON p.id=i.project_id AND p.organization_id=i.organization_id
      JOIN harness.users iu ON iu.id=i.invitee_user_id AND iu.organization_id=i.organization_id
      JOIN harness.users ru ON ru.id=i.inviter_user_id AND ru.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND (i.invitee_user_id=$2 OR i.inviter_user_id=$2 OR p.owner_user_id=$2 OR EXISTS (
        SELECT 1 FROM harness.memberships administrator
        WHERE administrator.organization_id=i.organization_id AND administrator.user_id=$2
          AND administrator.role='admin' AND administrator.status='active'
      ))
        AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM harness.instances target
          WHERE target.organization_id=i.organization_id AND target.project_id=i.project_id
            AND harness.entry_node_visible(target.organization_id,$3,target.assigned_node_id)))
        ${projectClause} ORDER BY i.created_at DESC,i.id`, values)
    const local=projectId===undefined?[]:result.rows.filter(row=>row.content?.nodeId===this.context.nodeId)
    const names=await localProjectDisplays(this.placement?.metadata,local)
    return result.rows.map(row=>this.invitationFromRow(row.id,row.content && names.has(row.content.projectId)
      ? {...row,project_name:names.get(row.content.projectId)!.name}:row))
  }

  async countPendingInvitations(userId: number): Promise<number> {
    const internalUser = await internalUserId(this.context.pool, this.context.organizationId, userId)
    if (internalUser === null) return 0
    const result = await this.context.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text n FROM harness.project_invitations i
       WHERE organization_id=$1 AND invitee_user_id=$2 AND status='pending'
         AND (expires_at IS NULL OR expires_at>clock_timestamp())
         AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM harness.instances target
           WHERE target.organization_id=i.organization_id AND target.project_id=i.project_id
             AND harness.entry_node_visible(target.organization_id,$3,target.assigned_node_id)))`,
      [this.context.organizationId, internalUser, this.entryNodeId ?? null],
    )
    return Number(result.rows[0]?.n ?? 0)
  }

  async acceptInvitation(invitationId: string, userId: number): Promise<void> {
    if (!isUuid(invitationId)) throw new Error('invitation-not-found')
    const result = await transaction(this.context.pool, async (client) => {
      const internalUser = await this.activeMutationUser(client, userId, 'actor')
      // Membership edits and invitation acceptance share the project lock before either row is changed.
      const selected = await client.query<{ status: string }>(`SELECT p.status FROM harness.projects p
        JOIN harness.project_invitations i ON i.project_id=p.id AND i.organization_id=p.organization_id
        WHERE i.organization_id=$1 AND i.id=$2 FOR UPDATE OF p`, [this.context.organizationId, invitationId])
      if (selected.rows[0] === undefined) throw new Error('invitation-not-found')
      if (selected.rows[0].status !== 'active') throw new CollaborationDeniedError('forbidden')
      const invitation = await client.query<{
        project_id: string; invitee_user_id: string; access_mode: GrantMode; status: ProjectInvitationStatus; expired: boolean
      }>(`WITH invitation AS MATERIALIZED (
        SELECT project_id,invitee_user_id,access_mode,status,expires_at FROM harness.project_invitations
        WHERE organization_id=$1 AND id=$2 FOR UPDATE
      ) SELECT project_id,invitee_user_id,access_mode,status,
        (expires_at IS NOT NULL AND expires_at<=clock_timestamp()) expired FROM invitation`, [this.context.organizationId, invitationId])
      const row = invitation.rows[0]
      if (row === undefined) throw new Error('invitation-not-found')
      if (row.invitee_user_id !== internalUser) throw new Error('invitation-forbidden')
      if (row.status !== 'pending') throw new Error('invitation-not-pending')
      await this.assertOrganizationActive(client)
      await this.lockInvitationComputer(client, row.project_id, internalUser)
      if (row.expired) {
        await client.query(`UPDATE harness.project_invitations SET status='expired',responded_at=now()
          WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, invitationId])
        return 'expired' as const
      }
      await client.query(`INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode)
        VALUES($1,$2,$3,$4) ON CONFLICT(project_id,user_id) DO NOTHING`, [
        this.context.organizationId, row.project_id, internalUser, row.access_mode,
      ])
      await client.query(`UPDATE harness.project_invitations SET status='accepted',responded_at=now()
        WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, invitationId])
      return 'accepted' as const
    })
    if (result === 'expired') throw new Error('invitation-expired')
  }

  private invitationFromRow(id: string, row: Omit<InvitationSelectRow, 'id'> | InvitationSelectRow): ProjectInvitation {
    return {
      id,
      projectId: publicNumber(row.project_public_id, 'project'),
      projectName: row.project_name,
      invitee: { id: publicNumber(row.invitee_public_id, 'user'), username: row.invitee_username, displayName: row.invitee_display_name },
      inviter: { id: publicNumber(row.inviter_public_id, 'user'), username: row.inviter_username, displayName: row.inviter_display_name },
      mode: row.mode,
      status: row.status,
      expiresAt: row.expires_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      respondedAt: row.responded_at?.toISOString() ?? null,
    }
  }

  private async invitationById(id: string): Promise<ProjectInvitation> {
    const result = await this.context.pool.query<Omit<InvitationSelectRow, 'id'>>(`SELECT p.public_id::text project_public_id,harness.project_content_key(p.organization_id,p.id) content,CASE WHEN harness.project_content_key(p.organization_id,p.id) IS NULL THEN p.name::text ELSE '#'||p.public_id::text END project_name,
      iu.public_id::text invitee_public_id,iu.username::text invitee_username,iu.display_name invitee_display_name,
      ru.public_id::text inviter_public_id,ru.username::text inviter_username,ru.display_name inviter_display_name,
      i.access_mode mode,CASE WHEN i.status='pending' AND i.expires_at<=clock_timestamp() THEN 'expired' ELSE i.status END status,
      i.expires_at,i.created_at,i.responded_at
      FROM harness.project_invitations i
      JOIN harness.projects p ON p.id=i.project_id AND p.organization_id=i.organization_id
      JOIN harness.users iu ON iu.id=i.invitee_user_id AND iu.organization_id=i.organization_id
      JOIN harness.users ru ON ru.id=i.inviter_user_id AND ru.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND i.id=$2`, [this.context.organizationId, id])
    const row = result.rows[0]
    if (row === undefined) throw new Error('invitation-not-found')
    const names=await localProjectDisplays(this.placement?.metadata,[row])
    return this.invitationFromRow(id,row.content?{...row,project_name:names.get(row.content.projectId)!.name}:row)
  }

  async effectiveGrants(userId: number): Promise<EffectiveGrant[]> {
    const home = await this.context.pool.query<{ home_path: string }>(
      `SELECT a.home_path FROM harness.users u JOIN harness.node_user_accounts a
        ON a.organization_id=u.organization_id AND a.user_id=u.id AND a.node_id=$3
        WHERE u.organization_id=$1 AND u.public_id=$2`,
      [this.context.organizationId, userId, this.context.nodeId],
    )
    const grants: EffectiveGrant[] = []
    if (home.rows[0] !== undefined) grants.push({ path: home.rows[0].home_path, mode: 'rw', label: '主目录' })
    const projects = await this.context.pool.query<{ path: string; label: string; mode: GrantMode } & ProjectContentRef>(`SELECT
      pm.local_path path,p.name::text label,harness.project_content_key(p.organization_id,p.id) content,m.access_mode mode
      FROM harness.project_members m
      JOIN harness.users u ON u.id=m.user_id AND u.organization_id=m.organization_id
      JOIN harness.projects p ON p.id=m.project_id AND p.organization_id=m.organization_id
      JOIN harness.project_mounts pm ON pm.project_id=p.id AND pm.organization_id=p.organization_id
        AND pm.node_id=$3 AND pm.status='active'
      WHERE m.organization_id=$1 AND u.public_id=$2 AND p.status='active' ORDER BY pm.local_path`,
    [this.context.organizationId, userId, this.context.nodeId])
    const metadata=await localProjectDisplays(this.placement?.metadata,projects.rows)
    for (const row of projects.rows) {
      const owned=row.content?metadata.get(row.content.projectId):undefined
      grants.push({path:owned?.rootPath??row.path,mode:row.mode,label:owned?.name??row.label})
    }
    return grants
  }

  private async assertNotReserved(queryable: Queryable, canonical: string, allowUserProjectsRoot: boolean): Promise<void> {
    assertProjectImportPathAllowed(this.cfg, canonical, { allowUserProjectsRoot })
    const users = await queryable.query<{ username: string; home_path: string }>(
      `SELECT u.username::text,a.home_path FROM harness.users u JOIN harness.node_user_accounts a
        ON a.organization_id=u.organization_id AND a.user_id=u.id AND a.node_id=$2 WHERE u.organization_id=$1`,
      [this.context.organizationId, this.context.nodeId],
    )
    for (const user of users.rows) {
      const home = realpathIfPresent(user.home_path) ?? user.home_path
      if (projectPathsOverlap(canonical, home)) {
        throw new Error('project-path-reserved')
      }
      const dsh = join(this.cfg.usersRoot, user.username)
      const canonicalDsh = realpathIfPresent(dsh) ?? dsh
      if (projectPathsOverlap(canonical, canonicalDsh)) {
        throw new Error('project-path-reserved')
      }
    }
    const projects = await queryable.query<{ path: string } & ProjectContentRef>(`SELECT pm.canonical_path path,harness.project_content_key(p.organization_id,p.id) content
      FROM harness.project_mounts pm
      JOIN harness.projects p ON p.id=pm.project_id AND p.organization_id=pm.organization_id
      WHERE pm.organization_id=$1 AND pm.node_id=$2 AND pm.status='active' AND p.status='active'`,
    [this.context.organizationId, this.context.nodeId])
    const roots=await localProjectDisplays(this.placement?.metadata,projects.rows)
    const overlap = projects.rows.find(project => projectPathsOverlap(canonical, project.content?roots.get(project.content.projectId)!.rootPath:project.path))
    if (overlap !== undefined) throw new Error('project-path-overlap')
  }
}
