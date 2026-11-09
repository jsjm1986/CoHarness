/** Central Workspace metadata retains offline directories without starting their Runtimes. @module */
import { createHash } from 'node:crypto'
import { recordNodeContentDomainReceipt, requireNodeContentRelations, type NodeContentCheckInput } from './node-content-publication.ts'
import { z } from 'zod'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { RuntimeCredentialSubject } from './runtime-api.ts'
import type { UserRow } from './auth.ts'
import { transaction } from './postgres/database.ts'
import { publicationDigest, type PersonalNodeIndex } from './personal-index.ts'
import { getProjectContentBinding, NodeContentUnavailable, type NodeContentBinding, type NodeContentStore } from './node-content-store.ts'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import { CollaborationDeniedError } from './collaboration.ts'
import type { RowSelection, WorkbenchRowsPage } from './workbench-rows.ts'
import type { RuntimeId, RuntimeNodeId } from './runtime-catalog.ts'

const conversation = z.object({ sessionId: z.string().min(1).max(256), updatedAt: z.number().finite().nonnegative(),
  blank: z.boolean(), title: z.string().optional(), cwd: z.string().max(4096).optional(),
  visibleContentSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  lastPromptAt: z.number().finite().nonnegative().optional() }).strict()
const workspace = z.object({ workspaceId: z.string().min(1).max(256), path: z.string().min(1).max(4096),
  title: z.string().max(4096), sessionIds: z.array(z.string().min(1).max(256)),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict()
const snapshot = z.object({ revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), items: z.array(workspace),
  conversations: z.array(conversation).optional() }).strict()

export type PersonalWorkspaceSnapshot = z.infer<typeof snapshot>

/** Runtime-owned Workspace directory projection; values are metadata, never execution authority. */
export class PostgresWorkspaceCatalog {
  constructor(private readonly context: PostgresRuntimeContext, private readonly entryNodeId?: RuntimeNodeId, private readonly local?: PersonalNodeIndex,
    private readonly projectStore?: Pick<NodeContentStore,'read'|'write'>) {}

  /**
   * Retain a newer publication from the currently authenticated Runtime generation.
   * @param subject - verified Runtime credential and generation.
   * @param value - untrusted metadata publication, excluding file contents.
   */
  async publish(subject: RuntimeCredentialSubject, value: unknown): Promise<void> {
    const data = snapshot.parse(value)
    if (subject.target.runtimeId === undefined) throw new Error('Workspace publication requires a Runtime identity')
    const runtime = subject.target.runtimeId
    if (subject.target.kind === 'project') {
      const binding = subject.contentBinding ?? await getProjectContentBinding(this.context.pool, subject.organizationId, runtime)
      if (binding !== undefined) {
        if (!this.projectStore || binding.nodeId !== this.context.nodeId || binding.organizationId !== subject.organizationId
          || binding.runtimeId !== runtime || (subject.projectInternalId !== undefined && subject.projectInternalId !== binding.projectId)) throw new NodeContentUnavailable()
        await this.projectStore.write(binding, async tx => {
          await tx.query(`INSERT INTO node_content.workspace_catalog(organization_id,project_id,runtime_id,generation,revision,items)
            VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(organization_id,runtime_id) DO UPDATE
              SET generation=excluded.generation, revision=excluded.revision, items=excluded.items
              WHERE (workspace_catalog.generation,workspace_catalog.revision)<(excluded.generation,excluded.revision)`,
          [binding.organizationId,binding.projectId,runtime,subject.generation,data.revision,JSON.stringify(data.items)])
        },subject.generation)
        return
      }
    }
    await transaction(this.context.pool, async client => {
      const current = await client.query<{ placed: boolean }>(`SELECT EXISTS(SELECT 1 FROM harness.personal_directory_placement p
        WHERE p.organization_id=i.organization_id AND p.runtime_id=i.runtime_id AND p.node_id=i.assigned_node_id AND p.owner_id=i.user_id) placed
        FROM harness.instances i WHERE i.organization_id=$1 AND i.runtime_id=$2 AND i.assigned_node_id=$3 AND i.generation=$4 FOR SHARE OF i`,
      [subject.organizationId, subject.target.runtimeId, this.context.nodeId, subject.generation])
      if (current.rowCount !== 1) throw new CollaborationDeniedError('forbidden')
      if (current.rows[0]!.placed) {
        if (this.local === undefined || subject.target.kind !== 'user') throw new NodeContentUnavailable()
        await this.local.publish({ organizationId: subject.organizationId, nodeId: this.context.nodeId, runtimeId: subject.target.runtimeId!,
          userId: subject.target.id }, { generation: subject.generation, snapshot: data })
        return
      }
      await client.query(`INSERT INTO harness.runtime_workspace_catalog(organization_id,runtime_id,generation,revision,items,conversations)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)
      ON CONFLICT(organization_id,runtime_id) DO UPDATE SET generation=excluded.generation,revision=excluded.revision,
        items=excluded.items,conversations=excluded.conversations,updated_at=clock_timestamp()
      WHERE (runtime_workspace_catalog.generation,runtime_workspace_catalog.revision)<(excluded.generation,excluded.revision)`,
      [subject.organizationId, subject.target.runtimeId, subject.generation, data.revision, JSON.stringify(data.items),
        data.conversations === undefined ? null : JSON.stringify(data.conversations)])
    })
  }

  /** Verify or copy the current workspace publication while the authenticated writer is fenced.
   * @param input - prospective project placement and both locked transactions.
   */
  async verifyNodeContent({local,control,binding:b,migration}:NodeContentCheckInput):Promise<void>{
    if (!this.projectStore || b.nodeId!==this.context.nodeId || b.organizationId!==this.context.organizationId) throw new NodeContentUnavailable()
    await requireNodeContentRelations(local,['workspace_catalog'])
    if (!migration) return
    const source=await control.query<{generation:string;revision:string;items:unknown;conversations:unknown}>(`SELECT generation::text,revision::text,items,conversations
      FROM harness.runtime_workspace_catalog WHERE organization_id=$1 AND runtime_id=$2 FOR SHARE`,[b.organizationId,b.runtimeId])
    const row=source.rows[0]
    if (row) {
      const items=z.array(workspace).parse(row.items)
      await local.query(`INSERT INTO node_content.workspace_catalog(organization_id,project_id,runtime_id,generation,revision,items,predecessor_conversations)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,runtime_id) DO UPDATE SET generation=excluded.generation,
        revision=excluded.revision,items=excluded.items,predecessor_conversations=excluded.predecessor_conversations
        WHERE workspace_catalog.project_id=excluded.project_id`,[b.organizationId,b.projectId,b.runtimeId,row.generation,row.revision,
        JSON.stringify(items),row.conversations===null?null:JSON.stringify(z.array(conversation).parse(row.conversations))])
    }
    const result=await local.query(`SELECT generation::text,revision::text,items,predecessor_conversations AS conversations
      FROM node_content.workspace_catalog WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3`,[b.organizationId,b.projectId,b.runtimeId])
    const digest=(rows:unknown)=>createHash('sha256').update(JSON.stringify(rows)).digest()
    if (!digest(result.rows).equals(digest(source.rows))) throw new NodeContentUnavailable('The workspace publication differs from its source.')
    await recordNodeContentDomainReceipt(local,{snapshotId:migration.snapshotId,sourceRevision:migration.sourceRevision,domain:'workspace',
      records:result.rows.length,digest:digest(result.rows)})
  }

  /** Inspect the current personal allocation, directory publication and incomplete history without starting its Runtime. */
  async previewPersonal(actor:number,runtimeId:RuntimeId) {
    return transaction(this.context.pool,async tx=>{
      await lockAdministrator(tx,this.context,actor)
      const result=await tx.query<{userId:number;generation:number;published:boolean;revision:number|null;complete:boolean;workspaces:number;conversations:number}>(`SELECT
        u.public_id::int "userId",i.generation::float8 generation,p.runtime_id IS NOT NULL published,c.revision::float8 revision,
        COALESCE(c.generation=i.generation AND c.conversations IS NOT NULL AND NOT EXISTS(SELECT FROM harness.conversation_sessions s
          WHERE s.organization_id=e.organization_id AND s.runtime_id=e.id AND s.id=s.root_session_id AND s.status<>'deleted'
          AND NOT EXISTS(SELECT FROM jsonb_array_elements(c.conversations) v WHERE v->>'sessionId'=s.id)),false) complete,
        COALESCE(jsonb_array_length(c.items),0) workspaces,COALESCE(jsonb_array_length(c.conversations),0) conversations
        FROM harness.runtime_environments e JOIN harness.users u ON (u.organization_id,u.id)=(e.organization_id,e.owner_id)
        JOIN harness.instances i ON (i.organization_id,i.runtime_id,i.user_id,i.assigned_node_id)=(e.organization_id,e.id,e.owner_id,e.node_id)
        LEFT JOIN harness.runtime_workspace_catalog c ON (c.organization_id,c.runtime_id)=(e.organization_id,e.id)
        LEFT JOIN harness.personal_directory_placement p ON (p.organization_id,p.runtime_id,p.node_id,p.owner_id)=(e.organization_id,e.id,e.node_id,e.owner_id)
        WHERE e.organization_id=$1 AND e.node_id=$2 AND e.id=$3 AND e.owner_kind='user' AND e.retired_at IS NULL`,
      [this.context.organizationId,this.context.nodeId,runtimeId])
      const row=result.rows[0]
      if(!row)throw new CollaborationDeniedError('forbidden')
      return {...row,nodeId:this.context.nodeId,runtimeId,ready:!!this.local && row.complete && !row.published}
    })
  }

  /**
   * Publish a local copy before committing its one-way directory placement. Unindexed legacy conversations block the switch.
   * @param actor - current organization administrator.
   * @param runtimeId - one live personal allocation on this computer.
   * @param expected - exact account, node and versions reviewed by an interactive administrator.
   * @returns after governance and the local index agree on the cutover.
   */
  async promotePersonal(actor: number, runtimeId: RuntimeId, expected?:{nodeId:string;userId:number;generation:number;revision:number}): Promise<void> {
    if (this.local === undefined) throw new NodeContentUnavailable()
    const local = this.local
    await transaction(this.context.pool, async tx => {
      await lockAdministrator(tx, this.context, actor)
      const { rows } = await tx.query<{ user_id: string; public_id: number; generation: number }>(`SELECT i.user_id,u.public_id::int,i.generation::float8 generation
        FROM harness.instances i JOIN harness.runtime_environments e ON e.id=i.runtime_id AND e.organization_id=i.organization_id
        JOIN harness.users u ON u.id=i.user_id AND u.organization_id=i.organization_id
        WHERE i.runtime_id=$1 AND i.organization_id=$2 AND i.assigned_node_id=$3 AND e.retired_at IS NULL AND e.owner_kind='user' FOR UPDATE OF i,e`,
        [runtimeId, this.context.organizationId, this.context.nodeId])
      const owner = rows[0]
      if (!owner) throw new CollaborationDeniedError('forbidden')
      if(expected && (expected.nodeId!==this.context.nodeId || expected.userId!==owner.public_id || expected.generation!==owner.generation))
        throw new NodeContentUnavailable('The personal directory selection changed. Review it again.')
      const already = await tx.query('SELECT 1 FROM harness.personal_directory_placement WHERE runtime_id=$1 AND organization_id=$2',[runtimeId,this.context.organizationId])
      if (already.rowCount) return
      const captured = await tx.query<{ revision: number; generation: number; items: unknown; conversations: unknown }>(`SELECT c.revision::float8 revision,c.generation::float8 generation,c.items,c.conversations
        FROM harness.runtime_workspace_catalog c WHERE c.organization_id=$1 AND c.runtime_id=$2 AND c.conversations IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM harness.conversation_sessions s WHERE s.organization_id=c.organization_id AND s.runtime_id=c.runtime_id
            AND s.id=s.root_session_id AND s.status<>'deleted' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c.conversations) v WHERE v->>'sessionId'=s.id))
        FOR UPDATE OF c`,[this.context.organizationId,runtimeId])
      const row = captured.rows[0]
      if (!row || row.generation !== owner.generation || expected && row.revision!==expected.revision) throw new NodeContentUnavailable('A complete current directory publication is required.')
      const publication = snapshot.parse({revision:row.revision, items:row.items, conversations:row.conversations})
      const durable = await local.publish({ organizationId: this.context.organizationId, nodeId: this.context.nodeId,runtimeId,userId:owner.public_id },
        { generation:row.generation,snapshot:publication })
      if (durable.generation !== row.generation || durable.revision !== row.revision || durable.digest !== publicationDigest(publication)) {
        throw new NodeContentUnavailable('The local publication does not match the source revision.')
      }
      await tx.query('INSERT INTO harness.personal_directory_placement(runtime_id,organization_id,node_id,owner_id) VALUES($1,$2,$3,$4)',
        [runtimeId,this.context.organizationId,this.context.nodeId,owner.user_id])
    })
  }

  /**
   * Page project workspace names without disclosing any private membership list.
   * @param runtimeId - ACL-checked local project Runtime.
   * @param binding - authoritative placement, absent for a legacy project.
   * @param page - validated node-scoped cursor and literal filter.
   * @returns workspace metadata with details outside the requested page omitted.
   */
  async projectWorkspaces(runtimeId: RuntimeId, binding: NodeContentBinding | undefined, page: RowSelection, root: string): Promise<WorkbenchRowsPage> {
    if (binding !== undefined && (this.projectStore === undefined || binding.nodeId !== this.context.nodeId || binding.runtimeId !== runtimeId)) throw new NodeContentUnavailable()
    const sql = `SELECT COALESCE((SELECT jsonb_agg(item ORDER BY item->>'workspaceId' COLLATE "C") FROM (
      SELECT (v-'sessionIds') || jsonb_build_object('sessionIds','[]'::jsonb) item
      FROM jsonb_array_elements(c.items) v WHERE (v->>'workspaceId') COLLATE "C">$3
        AND ($4::text='' OR strpos(lower(concat_ws(' ',v->>'title',v->>'path')),lower($4))>0)
        AND ($6::text IS NULL OR v->>'workspaceId'=$6)
      ORDER BY (v->>'workspaceId') COLLATE "C" LIMIT $5) selected),'[]'::jsonb) rows FROM
      ${binding === undefined ? 'harness.runtime_workspace_catalog' : 'node_content.workspace_catalog'} c WHERE c.organization_id=$1 AND c.runtime_id=$2`
    const values = [this.context.organizationId,runtimeId,page.afterId,page.query,page.limit,page.workspaceId]
    const result = binding === undefined ? await this.context.pool.query<{rows:unknown[]}>(sql,values)
      : await this.projectStore!.read(binding, tx => tx.query<{rows:unknown[]}>(sql,values))
    const data = result.rows[0]
    const items = data ? z.array(workspace).parse(data.rows) : []
    if (items.length > 0) {
      const base = await realpath(root)
      await Promise.all(items.map(async item => {
        if (!isAbsolute(item.path)) throw new CollaborationDeniedError('forbidden')
        const path = relative(base, await realpath(item.path))
        if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) throw new CollaborationDeniedError('forbidden')
      }))
    }
    return { runtimeId,items:[],workspaces:items,indexed:data !== undefined,nextCursor:null }
  }

  /** Recheck a captured personal composer by exact owner, computer, Runtime and Session, including current archive state. */
  async writablePersonalSession(userId: number, runtimeId: RuntimeId, sessionId: string): Promise<boolean> {
    const check = async () => (await this.context.pool.query<{ promoted: boolean; legacy: boolean }>(`SELECT p.runtime_id IS NOT NULL promoted,
      CASE WHEN p.runtime_id IS NULL THEN (r.id IS NOT NULL OR EXISTS(SELECT FROM harness.runtime_workspace_catalog c
        CROSS JOIN LATERAL jsonb_array_elements(c.conversations) e WHERE c.organization_id=a.organization_id AND c.runtime_id=a.id
          AND e->>'sessionId'=$5)) ELSE false END legacy
      FROM harness.runtime_environments a JOIN harness.users u ON u.id=a.owner_id AND u.organization_id=a.organization_id
      JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id AND m.status='active'
      JOIN harness.organizations o ON o.id=a.organization_id AND o.status='active'
      LEFT JOIN harness.personal_directory_placement p ON p.organization_id=a.organization_id AND p.runtime_id=a.id AND p.node_id=a.node_id AND p.owner_id=u.id
      LEFT JOIN harness.conversation_sessions r ON r.organization_id=a.organization_id AND r.runtime_id=a.id AND r.id=$5
      WHERE a.organization_id=$1 AND a.node_id=$2 AND a.id=$3 AND a.owner_kind='user' AND a.retired_at IS NULL AND u.public_id=$4
        AND u.status='active' AND u.deleted_at IS NULL AND harness.computer_use_allowed(a.organization_id,u.id,a.node_id)
        AND ($6::uuid IS NULL OR harness.entry_node_visible(a.organization_id,$6,a.node_id))
        AND (r.id IS NULL OR r.creator_user_id=u.id AND r.project_id IS NULL AND r.status='active' AND r.closed_at IS NULL)
        AND NOT EXISTS(SELECT FROM harness.conversation_archive_records d WHERE d.organization_id=a.organization_id AND d.runtime_id=a.id
          AND d.root_session_id=coalesce(r.root_session_id,$5) AND (d.state IN ('trash','purged') OR d.restored_at IS NULL))`,
    [this.context.organizationId,this.context.nodeId,runtimeId,userId,sessionId,this.entryNodeId ?? null])).rows[0]
    const before = await check()
    if (!before?.promoted) return before?.legacy === true
    if (!this.local) throw new NodeContentUnavailable()
    const found = await this.local.contains({organizationId:this.context.organizationId,nodeId:this.context.nodeId,runtimeId,userId},sessionId)
    return found && (await check())?.promoted === true
  }

  /** A collaborative composer needs a live, unarchived inherited root at its exact published storage location. */
  async openProjectSession(runtimeId: RuntimeId, sessionId: string): Promise<boolean> {
    const b = await getProjectContentBinding(this.context.pool,this.context.organizationId,runtimeId)
    const query = (namespace: 'harness'|'node_content') => `SELECT FROM ${namespace}.conversation_sessions s
      JOIN ${namespace}.conversation_sessions r ON r.organization_id=s.organization_id AND r.runtime_id=s.runtime_id AND r.id=s.root_session_id
      WHERE s.organization_id=$1 AND s.runtime_id=$2 AND s.id=$3 AND s.project_id IS NOT NULL AND r.status='active' AND s.status='active'
        AND r.closed_at IS NULL AND s.closed_at IS NULL AND NOT EXISTS (SELECT FROM ${namespace}.conversation_archive_records a
          WHERE a.organization_id=r.organization_id AND a.runtime_id=r.runtime_id AND a.root_session_id=r.id AND
            (a.state IN ('trash','purged') OR a.restored_at IS NULL))`
    const params = [this.context.organizationId,runtimeId,sessionId]
    if (!b) return !!(await this.context.pool.query(query('harness'),params)).rowCount
    if (!this.projectStore || b.nodeId !== this.context.nodeId) throw new NodeContentUnavailable()
    return this.projectStore.read(b,async tx=>!!(await tx.query(query('node_content'),params)).rowCount)
  }

  /**
   * Fetch one personal index page at its owner without loading the complete published snapshot over the network.
   * @param user - authenticated account.
   * @param runtimeId - exact personal allocation.
   * @param page - validated filters and keyset.
   * @returns workspace or conversation rows, with unknown indexing distinguished from an empty publication.
   */
  async personalPage(user: UserRow, runtimeId: RuntimeId, page: RowSelection): Promise<WorkbenchRowsPage> {
    const authorized = () => this.context.pool.query<{ node_name:string }>(`SELECT n.name::text node_name FROM harness.personal_directory_placement p
      JOIN harness.users u ON u.organization_id=p.organization_id AND u.id=p.owner_id
      JOIN harness.compute_nodes n ON n.organization_id=p.organization_id AND n.id=p.node_id
      JOIN harness.runtime_environments e ON e.id=p.runtime_id AND e.organization_id=p.organization_id AND e.retired_at IS NULL
      WHERE p.organization_id=$1 AND p.node_id=$2 AND p.runtime_id=$3 AND u.public_id=$4 AND u.status='active' AND u.deleted_at IS NULL
        AND n.status='active' AND e.owner_id=u.id AND e.owner_kind='user' AND e.node_id=p.node_id
        AND EXISTS(SELECT FROM harness.memberships m JOIN harness.organizations o ON o.id=m.organization_id AND o.status='active'
          WHERE m.organization_id=p.organization_id AND m.user_id=u.id AND m.status='active')
        AND ($5::uuid IS NULL OR harness.entry_node_visible(p.organization_id,$5,p.node_id))
        AND harness.computer_use_allowed(p.organization_id,u.id,p.node_id)`, [this.context.organizationId,this.context.nodeId,runtimeId,user.id,this.entryNodeId??null])
    const placement=await authorized()
    if (placement.rowCount) {
      if (this.local === undefined) throw new NodeContentUnavailable()
      const view = await this.local.page({organizationId:this.context.organizationId,nodeId:this.context.nodeId,runtimeId,userId:user.id},page)
      if (!(await authorized()).rowCount) throw new CollaborationDeniedError('forbidden')
      if (view === null) throw new NodeContentUnavailable()
      const runtime = {kind:'personal' as const,runtimeId,nodeId:this.context.nodeId as RuntimeNodeId,nodeName:placement.rows[0]!.node_name}
      return { runtimeId, indexed:view.indexed, nextCursor:null,
        workspaces:page.kind==='workspaces'?z.array(workspace).parse(view.rows):[],
        items:page.kind==='conversations'?z.array(conversation).parse(view.rows).map(item=>({...item,runtime,visibility:'personal',
          creatorUserId:user.id,creatorDisplayName:user.displayName || user.username,canWrite:true})):[] }
    }
    const workspaces = page.kind === 'workspaces'
    const result = await this.context.pool.query<{ node_id: RuntimeNodeId; node_name: string; indexed: boolean; rows: unknown[] }>(`
      SELECT n.id node_id,n.name::text node_name,c.runtime_id IS NOT NULL AND ${workspaces ? 'true' : 'c.conversations IS NOT NULL'} indexed,
        COALESCE((SELECT jsonb_agg(entry ORDER BY t DESC,id COLLATE "C") FROM (
          SELECT ${workspaces ? "v - 'sessionIds' || jsonb_build_object('sessionIds','[]'::jsonb)" : 'v'} entry,
            ${workspaces ? '0::numeric' : "(v->>'updatedAt')::numeric"} t, v->>'${workspaces ? 'workspaceId' : 'sessionId'}' id
          FROM jsonb_array_elements(c.${workspaces ? 'items' : 'conversations'}) v
          WHERE ($4::text='' OR strpos(lower(concat_ws(' ',v->>'title',v->>'${workspaces ? 'path' : 'cwd'}',v->>'${workspaces ? 'workspaceId' : 'sessionId'}')),lower($4))>0)
            AND (${workspaces ? "$5::text IS NULL OR v->>'workspaceId'=$5" : `$5::text IS NULL OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(c.items) w WHERE w->>'workspaceId'=$5 AND (w->'sessionIds') ? (v->>'sessionId'))`})
            AND ($6::numeric IS NULL OR ${workspaces ? "(v->>'workspaceId') COLLATE \"C\" > $7" : `(v->>'updatedAt')::numeric<$6 OR
              ((v->>'updatedAt')::numeric=$6 AND (v->>'sessionId') COLLATE "C" > $7)`})
          ORDER BY t DESC,(v->>'${workspaces ? 'workspaceId' : 'sessionId'}') COLLATE "C" LIMIT $8
        ) selected),'[]'::jsonb) rows
      FROM harness.users u JOIN harness.instances i ON i.organization_id=u.organization_id AND i.user_id=u.id AND i.runtime_id=$3
      JOIN harness.compute_nodes n ON n.organization_id=i.organization_id AND n.id=i.assigned_node_id
      LEFT JOIN harness.runtime_workspace_catalog c ON c.organization_id=i.organization_id AND c.runtime_id=i.runtime_id
        AND NOT EXISTS(SELECT 1 FROM harness.personal_directory_placement p WHERE p.organization_id=i.organization_id AND p.runtime_id=i.runtime_id)
      WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active' AND i.assigned_node_id=$9
        AND harness.computer_use_allowed(u.organization_id,u.id,i.assigned_node_id)`,
      [this.context.organizationId,user.id,runtimeId,page.query,page.workspaceId,page.afterTime,page.afterId,page.limit,this.context.nodeId])
    const row = result.rows[0]
    if (row === undefined) throw new CollaborationDeniedError('forbidden')
    const runtime = { kind: 'personal' as const, runtimeId, nodeId: row.node_id, nodeName: row.node_name }
    return { runtimeId, indexed: row.indexed, nextCursor: null,
      workspaces: workspaces ? z.array(workspace).parse(row.rows) : [],
      items: workspaces ? [] : z.array(conversation).parse(row.rows).map(item => ({ ...item, runtime, visibility: 'personal',
        creatorUserId: user.id, creatorDisplayName: user.displayName || user.username, canWrite: true })) }
  }

  /**
   * Read allocated personal directories under current computer permission.
   * @param user - authenticated organization account.
   * @returns cached metadata, retaining unknown synchronization separately from an empty directory.
   */
  async personal(user: UserRow): Promise<Array<{ runtime: { kind: 'personal'; runtimeId: RuntimeId; nodeId: RuntimeNodeId; nodeName: string };
    status: string; observedState: string; syncedAt: string | null; items: z.infer<typeof workspace>[];
    conversations?: z.infer<typeof conversation>[] }>> {
    const result = await this.context.pool.query<{ runtime_id: RuntimeId; node_id: RuntimeNodeId; node_name: string; status: string;
      observed_state: string; synced_at: Date | null; items: z.infer<typeof workspace>[] | null;
      conversations: z.infer<typeof conversation>[] | null }>(`SELECT i.runtime_id,i.assigned_node_id node_id,
      n.name::text node_name,n.status,i.observed_state,c.updated_at synced_at,c.items,c.conversations FROM harness.users u
      JOIN harness.instances i ON i.organization_id=u.organization_id AND i.user_id=u.id
      JOIN harness.compute_nodes n ON n.organization_id=i.organization_id AND n.id=i.assigned_node_id
      LEFT JOIN harness.runtime_workspace_catalog c ON c.organization_id=i.organization_id AND c.runtime_id=i.runtime_id
        AND NOT EXISTS(SELECT 1 FROM harness.personal_directory_placement p WHERE p.organization_id=i.organization_id AND p.runtime_id=i.runtime_id)
      WHERE u.organization_id=$1 AND u.public_id=$2 AND harness.computer_use_allowed(u.organization_id,u.id,i.assigned_node_id)
      AND ($3::uuid IS NULL OR harness.entry_node_visible(i.organization_id,$3,i.assigned_node_id))
      ORDER BY n.name,n.id,i.runtime_id`, [this.context.organizationId, user.id, this.entryNodeId ?? null])
    return result.rows.map(row => ({ runtime: { kind: 'personal', runtimeId: row.runtime_id, nodeId: row.node_id, nodeName: row.node_name },
      status: row.status, observedState: row.observed_state, syncedAt: row.synced_at?.toISOString() ?? null, items: z.array(workspace).parse(row.items ?? []),
      ...(row.conversations === null ? {} : { conversations: z.array(conversation).parse(row.conversations) }) }))
  }
}
