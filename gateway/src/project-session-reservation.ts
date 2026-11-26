/** A reservation authorizes only its creator's unmaterialized Session, never a substitute for an existing root. */
import type { Queryable } from './postgres/database.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import { NodeContentUnavailable } from './node-content-store.ts'

/** Organization-issued allocation and the internal creator identity of an unmaterialized project Session. */
export interface ProjectSessionReservationKey { organizationId:string;runtimeId:RuntimeId;projectId:string;sessionId:string;actorId:string }

/** Check an exact live reservation after materialized and archived identities have been excluded.
 * @param db - recorded content snapshot or final transaction. @param schema - recorded content database schema.
 * @param key - exact project, Runtime, Session and creator. @param lock - retain the reservation and recheck expiry after any wait.
 * @returns whether this creator still owns an unmaterialized reservation.
 */
export async function projectSessionReservation(db:Queryable,schema:'harness'|'node_content',key:ProjectSessionReservationKey,lock=false):Promise<boolean>{
  if(lock){
    const held=(await db.query<{held:boolean}>('SELECT pg_try_advisory_xact_lock_shared(hashtext($1)) held',
      [`conversation:${JSON.stringify([key.organizationId,key.runtimeId,key.sessionId])}`])).rows[0]?.held
    if(!held)throw new NodeContentUnavailable('The selected Session is being materialized. Retry with current access.')
  }
  const args=[key.organizationId,key.runtimeId,key.projectId,key.sessionId,key.actorId]
  let reservation:unknown
  try{reservation=(await db.query(`SELECT d.session_id FROM ${schema}.conversation_draft_reservations d
    WHERE d.organization_id=$1 AND d.runtime_id=$2 AND d.project_id=$3 AND d.session_id=$4 AND d.user_id=$5
      AND d.lease_expires_at>clock_timestamp()
      AND NOT EXISTS(SELECT FROM ${schema}.conversation_sessions c WHERE c.organization_id=$1 AND c.runtime_id=$2 AND c.id=$4)
      AND NOT EXISTS(SELECT FROM ${schema}.conversation_archive_records a WHERE a.organization_id=$1 AND a.runtime_id=$2 AND a.root_session_id=$4
        AND (a.state IN ('trash','purged') OR a.restored_at IS NULL))
    ${lock?'FOR SHARE OF d NOWAIT':''}`,args)).rows[0]}
  catch(error){
    if(error instanceof Error&&'code' in error&&error.code==='55P03')throw new NodeContentUnavailable('The selected draft reservation changed. Retry with current access.')
    throw error
  }
  if(!reservation)return false
  return !lock||projectSessionReservation(db,schema,key)
}
