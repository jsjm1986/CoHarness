/** The same timeline and precision-preserving cursor on shared and node-owned Session stores. */
import type { RuntimeId } from './runtime-catalog.ts'
import { publicNumber } from './postgres/runtime-context.ts'
import type { Queryable } from './postgres/database.ts'
import type { ProjectActivityItem, ProjectActivityPage } from './services.ts'
import { NodeContentUnavailable } from './node-content-store.ts'

interface ActivityRow {
  kind: 'message' | 'answer'
  session_id: string
  seq: string
  ts: Date
  text: string | null
  actor_label: string | null
  actor_uid: string
  question_args: string | null
  outcome: unknown
  conversation_title: string | null
  cursor_ts: string
  responder: string | null
  entry_id: string
}

interface ActivityCursor {
  ts: string
  sessionId: string
  seq: number
  /** Absent for millisecond cursors issued before individual answer identifiers were included. */
  entryId?: string
}

/** Decode a Runtime-qualified precision-preserving cursor; unscoped, foreign or malformed input reads the first page. */
function parseActivityCursor(raw: string | undefined, organizationId: string, runtimeId: RuntimeId): ActivityCursor | undefined {
  if (raw === undefined) return undefined
  if (raw.startsWith('v2.')) {
    const encoded = raw.slice(3), bytes = Buffer.from(encoded, 'base64url')
    if (bytes.toString('base64url') !== encoded) return undefined
    let value: unknown
    try { value = JSON.parse(bytes.toString('utf8')) } catch { return undefined }
    if (!Array.isArray(value) || value.length !== 6 || value[0] !== organizationId || value[1] !== runtimeId) return undefined
    const [, , ts, sessionId, seq, entryId] = value as unknown[]
    if (typeof ts !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(ts)
      || ts.startsWith('0000') || !Number.isFinite(Date.parse(ts))
      || new Date(ts).toISOString().slice(0, 23) !== ts.slice(0, 23)
      || typeof sessionId !== 'string' || sessionId === '' || sessionId.includes('\0')
      || typeof entryId !== 'string' || entryId === '' || entryId.includes('\0')
      || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < -1) return undefined
    return { ts, sessionId, seq, entryId }
  }
  return undefined
}

/** Render a claimed answer's selected labels and custom text into one bounded line. */
function answerSummary(outcome: unknown): string {
  const answers = (outcome as { answers?: unknown } | null)?.answers
  if (!Array.isArray(answers)) return ''
  return answers.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return ''
    const item = entry as { selected?: unknown; custom?: unknown }
    const selected = Array.isArray(item.selected)
      ? item.selected.filter((label): label is string => typeof label === 'string').join('、')
      : ''
    return [selected, typeof item.custom === 'string' ? item.custom : '']
      .filter(text => text !== '').join('：')
  }).filter(text => text !== '').join('；').slice(0, 300)
}

/** Extract the asked question texts from a serialized tool-call arguments payload. */
function questionText(raw: string | null): string | undefined {
  if (raw === null) return undefined
  try {
    const questions = (JSON.parse(raw) as { questions?: unknown }).questions
    if (!Array.isArray(questions)) return undefined
    const text = questions
      .map(entry => (entry as { question?: unknown }).question)
      .filter((question): question is string => typeof question === 'string' && question !== '')
      .join('；').slice(0, 300)
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

/** Normalize one UNION feed row into the wire item; `seq` -1 marks an unanchored answer. */
function activityItem(row: ActivityRow): ProjectActivityItem {
  const seq = Number(row.seq)
  if (row.kind === 'message') {
    return {
      kind: 'message', sessionId: row.session_id, conversationTitle: row.conversation_title,
      actorUserId: publicNumber(row.actor_uid, 'user'), actorLabel: row.actor_label ?? '',
      occurredAt: row.ts.toISOString(), seq, text: row.text ?? '',
    }
  }
  const question = questionText(row.question_args)
  return {
    kind: 'answer', sessionId: row.session_id, conversationTitle: row.conversation_title,
    actorUserId: publicNumber(row.actor_uid, 'user'), actorLabel: row.actor_label ?? '',
    occurredAt: row.ts.toISOString(), seq: seq < 0 ? null : seq,
    text: answerSummary(row.outcome),
    ...(question === undefined ? {} : { questionText: question }),
    outcome: row.outcome,
  }
}

/** Page activity after the caller has selected an authorized root relation.
 * @param query - selected content transaction.
 * @param input - trusted root query and credentials for this allocation.
 * @returns visible messages and submitted answers, including an exact continuation when more exist.
 */
export async function readProjectActivity(query: Queryable, input: {
  schema: 'harness'|'node_content'
  rootRelation: string
  coordinates: [string, string|number, string|number]
  organizationId: string
  runtimeId: RuntimeId
  limit: number
  before?: string
  people?: (ids:string[])=>Promise<Map<string,{ display_name:string; public_id:string }>>
}): Promise<ProjectActivityPage> {
    const {schema} = input, local=schema==='node_content'
    const limit = Math.min(Math.max(input.limit,1),200)
    const before = parseActivityCursor(input.before,input.organizationId,input.runtimeId)
    const result = await query.query<ActivityRow>(`WITH visible AS (
      SELECT r.organization_id,r.runtime_namespace,r.id,COALESCE(to_json(${schema}.human_session_title(r.title)), (SELECT ${schema}.conversation_search_text(search.content,search.content_nul_parts,80)
        FROM ${schema}.conversation_search search
        WHERE search.organization_id=r.organization_id AND search.runtime_namespace=r.runtime_namespace AND search.session_id=r.id AND search.role='user'
          AND ${schema}.human_session_title(search.content) IS NOT NULL
        ORDER BY search.occurred_at,search.event_seq LIMIT 1)) title
      ${input.rootRelation}
    ), feed AS (
      SELECT 'message'::text kind,e.organization_id,e.runtime_namespace,e.session_id,e.seq,e.occurred_at ts,
        ${schema}.conversation_search_text(search_row.content,search_row.content_nul_parts,500) text,
        (e.query_fields->>'actorLabelJson')::json actor_label,
        e.query_fields->>'actorUid' actor_uid,
        NULL::json question_args,NULL::json outcome,NULL::uuid responder,'message:' || e.seq::text entry_id
      FROM ${schema}.conversation_search search_row
      JOIN ${schema}.conversation_events e ON e.organization_id=search_row.organization_id AND e.runtime_namespace=search_row.runtime_namespace AND e.session_id=search_row.session_id
        AND e.seq=search_row.event_seq
      JOIN visible v ON v.organization_id=e.organization_id AND v.runtime_namespace=e.runtime_namespace AND v.id=e.session_id
      WHERE search_row.role='user' AND e.query_fields->>'actorUid' IS NOT NULL
      UNION ALL
      SELECT 'answer',c.organization_id,c.runtime_namespace,c.conversation_id,COALESCE(res.seq,-1),c.responded_at,
        NULL,${local ? 'NULL::json,NULL::text' : 'to_json(u.display_name),u.public_id::text'},
        (call_args.query_fields->>'argumentsJson')::json,c.outcome::json,c.responder_user_id,'question:' || c.interaction_id
      FROM ${schema}.conversation_interaction_responses c
      JOIN visible v ON v.organization_id=c.organization_id AND v.runtime_namespace=c.runtime_namespace AND v.id=c.conversation_id
      ${local ? '' : 'JOIN harness.users u ON u.id=c.responder_user_id AND u.organization_id=c.organization_id'}
      LEFT JOIN ${schema}.conversation_events res ON res.organization_id=c.organization_id AND res.runtime_namespace=c.runtime_namespace AND res.session_id=c.conversation_id
        AND res.event_type='tool/result' AND res.query_fields->>'callId'=c.call_id
      LEFT JOIN ${schema}.conversation_events call_args ON call_args.organization_id=c.organization_id AND call_args.runtime_namespace=c.runtime_namespace AND call_args.session_id=c.conversation_id
        AND call_args.event_type='tool/call' AND call_args.query_fields->>'callId'=c.call_id
      WHERE c.interaction_kind='question' AND ${local ? 'c.has_answers' : "jsonb_typeof(c.outcome->'answers')='array'"}
    )
    SELECT f.*,v.title conversation_title,
      to_char(f.ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_ts
    FROM feed f JOIN visible v ON v.organization_id=f.organization_id AND v.runtime_namespace=f.runtime_namespace AND v.id=f.session_id
    WHERE ($4::timestamptz IS NULL OR f.ts<$4 OR (f.ts=$4 AND (
      f.session_id>$5 OR (f.session_id=$5 AND (
        f.seq<$6::bigint OR (f.seq=$6::bigint AND $7::text IS NOT NULL AND f.entry_id>$7))))))
    ORDER BY f.ts DESC,f.session_id,f.seq DESC,f.entry_id LIMIT $8`,
      [...input.coordinates,
        before?.ts ?? null, before?.sessionId ?? '', before?.seq ?? 0, before?.entryId ?? null,
        limit + 1])
    const rows = result.rows.slice(0, limit)
    if (input.people !== undefined) {
      const answers = rows.filter(row=>row.kind==='answer')
      const people = await input.people(answers.map(row=>row.responder!))
      for (const row of answers) {
        const person = people.get(row.responder!)
        if (person === undefined) throw new NodeContentUnavailable('An activity responder identity is unavailable.')
        row.actor_label=person.display_name
        row.actor_uid=person.public_id
      }
    }
    const items = rows.map(row => activityItem(row))
    const last = result.rows.length > rows.length ? rows.at(-1) : undefined
    return {
      items,
      ...(last === undefined ? {} : { nextBefore: 'v2.' + Buffer.from(JSON.stringify([
        input.organizationId,input.runtimeId, last.cursor_ts, last.session_id, Number(last.seq), last.entry_id,
      ])).toString('base64url') }),
    }
}
