/** Durable project-digest request evidence and replayable project-infrastructure usage. */
import {requireNodeContentRelations,type NodeContentCheckInput} from '../node-content-publication.ts'
import { NodeContentUnavailable, type NodeContentStore,type NodeContentBinding } from '../node-content-store.ts'
import { transaction,type Queryable } from './database.ts'
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ResourceOperationId } from '@deepseek-ai/dsh-resource-budget/types'
import type { UsageEvent } from '../model-governance.ts'
import type { GatewayModelGovernanceService } from '../services.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'

/** Stable usage event and request-evidence identity. */
export type ProgressRequestId = Branded<'ProgressRequestId'>

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'gateway-project-progress': { readonly kind: 'gateway-project-progress' }
  }
}

/** Complete non-streaming request supported by project-progress inference. */
export interface ProgressModelRequest {
  readonly model: string
  readonly messages: readonly { readonly role: 'user'; readonly content: string }[]
  readonly max_tokens: number
  readonly temperature: number
  readonly stream: false
}

/** Exact model input persisted before network dispatch; credentials remain outside the journal. */
export interface ProgressRequestInput {
  readonly projectId: number
  readonly internalProjectId: string
  readonly actorId: number
  readonly operationId: ResourceOperationId
  readonly provider: string
  readonly credentialSource: 'organization' | 'project'
  readonly request: ProgressModelRequest
}

/** Final client-side result; missing provider counts remain explicitly unmetered. */
export interface ProgressRequestOutcome {
  readonly status: UsageEvent['status']
  readonly usage?: NonNullable<UsageEvent['usage']>
  readonly response?: string
}

interface PendingUsage {
  request_id: ProgressRequestId
  project_public_id: string
  occurred_at: Date
  provider: string
  model: string
  credential_source: 'organization' | 'project'
  status: UsageEvent['status']
  input_tokens: string | null
  output_tokens: string | null
  cache_read_tokens: string | null
  cache_write_tokens: string | null
}

/** Each inference attempt has a durable record even when its process dies before returning usage. */
export class PostgresProgressUsage {
  /** @param context - organization and node owning the request journal. @param governance - idempotent project billing sink. @param batchSize - maximum records replayed per sweep. @param assertDataEpoch - restored-data fence for this process's cached dependencies. */
  constructor(private readonly context: PostgresRuntimeContext,
    private readonly governance: Pick<GatewayModelGovernanceService, 'ingest'>, private readonly batchSize: number,
    private readonly assertDataEpoch?: () => Promise<void>,
    private readonly nodeContent?: Pick<NodeContentStore,'read'|'write'>) {}

  /** Check the actual configured usage sink and the node-local request journal. */
  async verifyNodeContent(input:NodeContentCheckInput):Promise<void>{
    this.store(input.binding)
    await requireNodeContentRelations(input.local,['project_journal_requests'])
    await input.control.query('SELECT request_id FROM harness.node_journal_deliveries WHERE organization_id=$1 AND project_id=$2 LIMIT 1',[input.binding.organizationId,input.binding.projectId])
  }

  /**
   * Persist complete request messages and a missing-usage placeholder before sending any bytes.
   * @param input - admitted request with verified initiating actor and project.
   * @returns stable request and billing event id.
   */
  async prepare(input: ProgressRequestInput,placement?:NodeContentBinding): Promise<ProgressRequestId> {
    await this.assertDataEpoch?.()
    const binding=placement??await this.bindingFor(input.internalProjectId)
    const id = randomUUID() as ProgressRequestId
    const occurredAt = Date.now()
    const session = Session.create(SessionId(id), undefined, {
      id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: occurredAt, isSeeded: false, delegationDepth: 0,
    })
    session.append('turn/start', { turn: 1 })
    for (const message of input.request.messages) session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: message.content }], source: { kind: 'gateway-project-progress' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { reason: 'initial', startsSeries: true, header: { config: {
      provider: input.provider, model: input.request.model, maxTokens: input.request.max_tokens, temperature: input.request.temperature,
    } } })
    const artifact = { header: session.header, inheritedEventCount: session.inheritedEventCount, events: session.events }
    const write=(db:Queryable,schema:'harness'|'node_content')=>db.query(`INSERT INTO ${schema}.project_journal_requests
      (organization_id,node_id,project_id,project_public_id,request_id,operation_id,actor_public_id,
        occurred_at,provider,model,credential_source,request,request_session)
      VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0),$9,$10,$11,$12::json,$13::json)`,
    [this.context.organizationId, this.context.nodeId, input.internalProjectId, input.projectId, id,
      input.operationId, input.actorId, occurredAt, input.provider, input.request.model, input.credentialSource,
      JSON.stringify(input.request), JSON.stringify(artifact)])
    if (binding) {
      const store=this.store(binding)
      await transaction(this.context.pool,async control=>{
        const marked=await control.query(`INSERT INTO harness.node_journal_deliveries(organization_id,project_id,node_id,runtime_id,request_id,operation_id)
          SELECT organization_id,project_id,node_id,runtime_id,$5,$6 FROM harness.project_content_placement
          WHERE organization_id=$1 AND project_id=$2 AND node_id=$3 AND runtime_id=$4 AND volume_id=$7 AND writer_epoch=$8`,
        [this.context.organizationId,input.internalProjectId,this.context.nodeId,binding.runtimeId,id,input.operationId,binding.volumeId,binding.writerEpoch])
        if (marked.rowCount!==1) throw new NodeContentUnavailable('Project digest billing placement changed before admission.')
        await store.write(binding,local=>write(local,'node_content'))
      })
    } else await write(this.context.pool,'harness')
    return id
  }

  private store(b:NodeContentBinding):Pick<NodeContentStore,'read'|'write'> {
    if (!this.nodeContent || b.organizationId!==this.context.organizationId || b.nodeId!==this.context.nodeId) throw new NodeContentUnavailable()
    return this.nodeContent
  }

  private async bindingFor(project:string):Promise<NodeContentBinding|undefined> {
    const row=(await this.context.pool.query<NodeContentBinding>(`SELECT organization_id "organizationId",project_id "projectId",node_id "nodeId",
      runtime_id "runtimeId",volume_id "volumeId",writer_epoch::text "writerEpoch" FROM harness.project_content_placement WHERE organization_id=$1 AND project_id=$2`,
    [this.context.organizationId,project])).rows[0]
    return row
  }


  /**
   * Commit the first final outcome; replay cannot replace it with a later error.
   * @param id - request whose network/body work has settled.
   * @param outcome - response evidence and disjoint token buckets.
   */
  async complete(id: ProgressRequestId, outcome: ProgressRequestOutcome,placement?:NodeContentBinding): Promise<void> {
    await this.assertDataEpoch?.()
    let binding=placement
    if (!binding) {
      const row=(await this.context.pool.query<{project_id:string}>('SELECT project_id FROM harness.node_journal_deliveries WHERE organization_id=$1 AND node_id=$2 AND request_id=$3',
        [this.context.organizationId,this.context.nodeId,id])).rows[0]
      if (row) { binding=await this.bindingFor(row.project_id); if (!binding) throw new NodeContentUnavailable() }
    }
    const write=(db:Queryable,schema:'harness'|'node_content')=>db.query(`UPDATE ${schema}.project_journal_requests SET completed=true,status=$4,response=$5,
      input_tokens=$6,output_tokens=$7,cache_read_tokens=$8,cache_write_tokens=$9
      WHERE organization_id=$1 AND node_id=$2 AND request_id=$3 AND NOT completed`,
    [this.context.organizationId, this.context.nodeId, id, outcome.status, outcome.response ?? null,
      outcome.usage?.inputTokens ?? null, outcome.usage?.outputTokens ?? null,
      outcome.usage?.cacheReadTokens ?? null, outcome.usage?.cacheWriteTokens ?? null])
    if (binding) {
      await this.store(binding).write(binding,local=>write(local,'node_content'))
      await this.context.pool.query('UPDATE harness.node_journal_deliveries SET completed=true WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3 AND request_id=$4',
        [binding.organizationId,binding.projectId,binding.runtimeId,id])
    } else await write(this.context.pool,'harness')
  }

  /**
   * Replay settled results, including interrupted attempts whose physical resource ownership ended.
   * @param id - one completed attempt, or omission for a bounded sweep.
   * @returns completion after idempotent billing and durable delivery acknowledgement.
   */
  async flush(id?: ProgressRequestId,placement?:NodeContentBinding): Promise<void> {
    await this.assertDataEpoch?.()
    const queued=await this.context.pool.query<{id:ProgressRequestId;project_id:string}>(`SELECT q.request_id id,q.project_id FROM harness.node_journal_deliveries q
      WHERE q.organization_id=$1 AND q.node_id=$2 AND ($3::uuid IS NULL OR q.request_id=$3)
        AND (q.completed OR NOT EXISTS(SELECT FROM harness.node_resource_requests a WHERE a.organization_id=q.organization_id AND a.node_id=q.node_id AND a.operation_id=q.operation_id))
      ORDER BY q.queued_at,q.request_id LIMIT $4`,[this.context.organizationId,this.context.nodeId,id??null,this.batchSize])
    for (const item of queued.rows) {
      const b=placement??await this.bindingFor(item.project_id)
      if (!b || b.projectId!==item.project_id) throw new NodeContentUnavailable()
      const store=this.store(b)
      const result=await store.read(b,local=>local.query<PendingUsage>(`SELECT request_id,project_public_id::text,occurred_at,provider,model,
        credential_source,status,input_tokens::text,output_tokens::text,cache_read_tokens::text,cache_write_tokens::text
        FROM node_content.project_journal_requests WHERE organization_id=$1 AND project_id=$2 AND node_id=$3 AND request_id=$4`,
      [b.organizationId,b.projectId,b.nodeId,item.id]))
      if (!result.rows[0]) throw new NodeContentUnavailable('The progress billing request is missing on its recorded volume.')
      await this.deliver(result.rows[0])
      await store.write(b,async local=>{await local.query(`UPDATE node_content.project_journal_requests SET delivered_at=COALESCE(delivered_at,now()) WHERE organization_id=$1 AND project_id=$2 AND request_id=$3`,[b.organizationId,b.projectId,item.id])})
      await this.context.pool.query('DELETE FROM harness.node_journal_deliveries WHERE organization_id=$1 AND project_id=$2 AND request_id=$3',[b.organizationId,b.projectId,item.id])
    }
    if (placement) return
    const result = await this.context.pool.query<PendingUsage>(`SELECT request_id,project_public_id::text,occurred_at,provider,model,
      credential_source,status,input_tokens::text,output_tokens::text,cache_read_tokens::text,cache_write_tokens::text
      FROM harness.project_journal_requests r WHERE organization_id=$1 AND node_id=$2 AND delivered_at IS NULL
        AND NOT EXISTS(SELECT FROM harness.project_content_placement b WHERE b.organization_id=r.organization_id AND b.project_id=r.project_id)
        AND ($3::uuid IS NULL OR request_id=$3)
        AND (completed OR NOT EXISTS(SELECT 1 FROM harness.node_resource_requests a
          WHERE a.organization_id=r.organization_id AND a.node_id=r.node_id AND a.operation_id=r.operation_id))
      ORDER BY occurred_at,request_id LIMIT $4`, [this.context.organizationId, this.context.nodeId, id ?? null, this.batchSize])
    for (const row of result.rows) {
      await this.deliver(row)
      await this.context.pool.query(`UPDATE harness.project_journal_requests SET delivered_at=now()
        WHERE organization_id=$1 AND node_id=$2 AND request_id=$3`, [this.context.organizationId, this.context.nodeId, row.request_id])
    }
  }

  private async deliver(row:PendingUsage):Promise<void>{
      await this.assertDataEpoch?.()
      const usage = row.input_tokens === null || row.output_tokens === null ? undefined : {
        inputTokens: count(row.input_tokens), outputTokens: count(row.output_tokens),
        ...(row.cache_read_tokens === null ? {} : { cacheReadTokens: count(row.cache_read_tokens) }),
        ...(row.cache_write_tokens === null ? {} : { cacheWriteTokens: count(row.cache_write_tokens) }),
      }
      // A digest is project infrastructure. A manual button click supplies queue attribution, not a fabricated model-input participant.
      await this.governance.ingest({ kind: 'project', id: count(row.project_public_id) }, {
        eventId: row.request_id, occurredAt: row.occurred_at.getTime(), provider: row.provider, model: row.model,
        purpose: 'project-progress', credentialSource: row.credential_source, credentialClass: 'company',
        status: row.status, ...(usage === undefined ? {} : { usage }),
      })
  }
}

function count(raw: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Stored progress usage exceeds the supported token range')
  return value
}
