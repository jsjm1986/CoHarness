/** Durable project-digest request evidence and replayable project-infrastructure usage. */
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
    private readonly assertDataEpoch?: () => Promise<void>) {}

  /**
   * Persist complete request messages and a missing-usage placeholder before sending any bytes.
   * @param input - admitted request with verified initiating actor and project.
   * @returns stable request and billing event id.
   */
  async prepare(input: ProgressRequestInput): Promise<ProgressRequestId> {
    await this.assertDataEpoch?.()
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
    await this.context.pool.query(`INSERT INTO harness.project_journal_requests
      (organization_id,node_id,project_id,project_public_id,request_id,operation_id,actor_public_id,
        occurred_at,provider,model,credential_source,request,request_session)
      VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0),$9,$10,$11,$12::json,$13::json)`,
    [this.context.organizationId, this.context.nodeId, input.internalProjectId, input.projectId, id,
      input.operationId, input.actorId, occurredAt, input.provider, input.request.model, input.credentialSource,
      JSON.stringify(input.request), JSON.stringify(artifact)])
    return id
  }

  /**
   * Commit the first final outcome; replay cannot replace it with a later error.
   * @param id - request whose network/body work has settled.
   * @param outcome - response evidence and disjoint token buckets.
   */
  async complete(id: ProgressRequestId, outcome: ProgressRequestOutcome): Promise<void> {
    await this.assertDataEpoch?.()
    await this.context.pool.query(`UPDATE harness.project_journal_requests SET completed=true,status=$4,response=$5,
      input_tokens=$6,output_tokens=$7,cache_read_tokens=$8,cache_write_tokens=$9
      WHERE organization_id=$1 AND node_id=$2 AND request_id=$3 AND NOT completed`,
    [this.context.organizationId, this.context.nodeId, id, outcome.status, outcome.response ?? null,
      outcome.usage?.inputTokens ?? null, outcome.usage?.outputTokens ?? null,
      outcome.usage?.cacheReadTokens ?? null, outcome.usage?.cacheWriteTokens ?? null])
  }

  /**
   * Replay settled results, including interrupted attempts whose physical resource ownership ended.
   * @param id - one completed attempt, or omission for a bounded sweep.
   * @returns completion after idempotent billing and durable delivery acknowledgement.
   */
  async flush(id?: ProgressRequestId): Promise<void> {
    await this.assertDataEpoch?.()
    const result = await this.context.pool.query<PendingUsage>(`SELECT request_id,project_public_id::text,occurred_at,provider,model,
      credential_source,status,input_tokens::text,output_tokens::text,cache_read_tokens::text,cache_write_tokens::text
      FROM harness.project_journal_requests r WHERE organization_id=$1 AND node_id=$2 AND delivered_at IS NULL
        AND ($3::uuid IS NULL OR request_id=$3)
        AND (completed OR NOT EXISTS(SELECT 1 FROM harness.node_resource_requests a
          WHERE a.organization_id=r.organization_id AND a.node_id=r.node_id AND a.operation_id=r.operation_id))
      ORDER BY occurred_at,request_id LIMIT $4`, [this.context.organizationId, this.context.nodeId, id ?? null, this.batchSize])
    for (const row of result.rows) {
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
      await this.context.pool.query(`UPDATE harness.project_journal_requests SET delivered_at=now()
        WHERE organization_id=$1 AND node_id=$2 AND request_id=$3`, [this.context.organizationId, this.context.nodeId, row.request_id])
    }
  }
}

function count(raw: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Stored progress usage exceeds the supported token range')
  return value
}
