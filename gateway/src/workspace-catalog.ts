/** Central Workspace metadata retains offline directories without starting their Runtimes. @module */
import { z } from 'zod'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { RuntimeCredentialSubject } from './runtime-api.ts'
import type { UserRow } from './auth.ts'
import { transaction } from './postgres/database.ts'
import { CollaborationDeniedError } from './collaboration.ts'
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

/** Runtime-owned Workspace directory projection; values are metadata, never execution authority. */
export class PostgresWorkspaceCatalog {
  constructor(private readonly context: PostgresRuntimeContext, private readonly entryNodeId?: RuntimeNodeId) {}

  /**
   * Retain a newer publication from the currently authenticated Runtime generation.
   * @param subject - verified Runtime credential and generation.
   * @param value - untrusted metadata publication, excluding file contents.
   */
  async publish(subject: RuntimeCredentialSubject, value: unknown): Promise<void> {
    const data = snapshot.parse(value)
    if (subject.target.runtimeId === undefined) throw new Error('Workspace publication requires a Runtime identity')
    await transaction(this.context.pool, async client => {
      const current = await client.query(`SELECT 1 FROM harness.instances
        WHERE organization_id=$1 AND runtime_id=$2 AND assigned_node_id=$3 AND generation=$4 FOR SHARE`,
      [subject.organizationId, subject.target.runtimeId, this.context.nodeId, subject.generation])
      if (current.rowCount !== 1) throw new CollaborationDeniedError('forbidden')
      await client.query(`INSERT INTO harness.runtime_workspace_catalog(organization_id,runtime_id,generation,revision,items,conversations)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)
      ON CONFLICT(organization_id,runtime_id) DO UPDATE SET generation=excluded.generation,revision=excluded.revision,
        items=excluded.items,conversations=excluded.conversations,updated_at=clock_timestamp()
      WHERE (runtime_workspace_catalog.generation,runtime_workspace_catalog.revision)<(excluded.generation,excluded.revision)`,
      [subject.organizationId, subject.target.runtimeId, subject.generation, data.revision, JSON.stringify(data.items),
        data.conversations === undefined ? null : JSON.stringify(data.conversations)])
    })
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
      WHERE u.organization_id=$1 AND u.public_id=$2 AND harness.computer_use_allowed(u.organization_id,u.id,i.assigned_node_id)
      AND ($3::uuid IS NULL OR harness.entry_node_visible(i.organization_id,$3,i.assigned_node_id))
      ORDER BY n.name,n.id,i.runtime_id`, [this.context.organizationId, user.id, this.entryNodeId ?? null])
    return result.rows.map(row => ({ runtime: { kind: 'personal', runtimeId: row.runtime_id, nodeId: row.node_id, nodeName: row.node_name },
      status: row.status, observedState: row.observed_state, syncedAt: row.synced_at?.toISOString() ?? null, items: z.array(workspace).parse(row.items ?? []),
      ...(row.conversations === null ? {} : { conversations: z.array(conversation).parse(row.conversations) }) }))
  }
}
