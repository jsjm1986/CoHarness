/** Migration100 backfills derived query fields without rewriting original event JSON. @module */
import type { PoolClient } from 'pg'
import { conversationQueryFieldsV1 } from './conversation-query-fields-v1.ts'

/**
 * @param client - client holding migration100's transaction and migration lock.
 * @returns completion after every legacy row has query fields and their required-field check is validated.
 */
export async function backfillConversationQueryFieldsV1(client: PoolClient): Promise<void> {
  // ALTER TABLE already holds an exclusive lock; unassigned legacy rows keep their recorded Runtime.
  await client.query('ALTER TABLE harness.conversation_events DROP CONSTRAINT conversation_event_runtime_registered')
  let after: readonly [string, string, string, string] | undefined
  while (true) {
    const batch = await client.query<{ organization_id: string; runtime_namespace: string; session_id: string; seq: string; event: unknown }>(`SELECT organization_id,runtime_namespace,session_id,seq::text,event
      FROM harness.conversation_events event WHERE query_fields IS NULL
        AND ($1::uuid IS NULL OR (organization_id,runtime_namespace,session_id,seq)>($1::uuid,$2::text,$3::text,$4::bigint))
      ORDER BY event.organization_id,event.runtime_namespace,event.session_id,event.seq LIMIT 100 FOR UPDATE`,
    [after?.[0] ?? null, after?.[1] ?? '', after?.[2] ?? '', after?.[3] ?? '0'])
    if (batch.rows.length === 0) break
    const values: unknown[] = []
    const rows = batch.rows.map((row, index) => {
      const base = index * 5
      values.push(row.organization_id, row.runtime_namespace, row.session_id, row.seq, JSON.stringify(conversationQueryFieldsV1(row.event)))
      return `($${String(base + 1)}::uuid,$${String(base + 2)}::text,$${String(base + 3)}::text,$${String(base + 4)}::bigint,$${String(base + 5)}::jsonb)`
    })
    await client.query(`UPDATE harness.conversation_events event SET query_fields=item.fields
      FROM (VALUES ${rows.join(',')}) item(organization_id,runtime_namespace,session_id,seq,fields)
      WHERE event.organization_id=item.organization_id AND event.runtime_namespace=item.runtime_namespace
        AND event.session_id=item.session_id AND event.seq=item.seq`, values)
    const last = batch.rows.at(-1)!
    after = [last.organization_id, last.runtime_namespace, last.session_id, last.seq]
  }
  await client.query('ALTER TABLE harness.conversation_events ADD CONSTRAINT conversation_event_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID')
  await client.query('ALTER TABLE harness.conversation_events VALIDATE CONSTRAINT conversation_event_query_fields')
}
