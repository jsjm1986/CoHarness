/** Process-lifetime exclusion for a database restore and its managed-file reconciliation. */
import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { DEPLOYMENT_DATA_LOCK, DEPLOYMENT_SQL_LOCK, MaintenanceError } from './maintenance-service.ts'

/** Dedicated backend ownership carried into the independent restore SQL transaction. */
export interface DeploymentDataLease extends AsyncDisposable {
  signal: AbortSignal
  owner: { pid: number; backendStart: string; token: string }
}

/**
 * Keep competing appliers out until database and file work have both settled.
 * @param pool - destination database; the lock survives schema replacement.
 * @returns a caller-owned lease whose signal aborts work if its database connection is lost.
 */
export async function acquireDeploymentDataLock(pool: Pool): Promise<DeploymentDataLease> {
  const client = await pool.connect(), lifetime = new AbortController()
  const token = `hgw-data-${randomUUID()}`
  let owner: DeploymentDataLease['owner']
  const lost = (error: Error) => { lifetime.abort(error) }
  client.on('error', lost)
  try {
    const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [DEPLOYMENT_DATA_LOCK])
    if (result.rows[0]?.locked !== true) throw new MaintenanceError(409, 'deployment-data-operation-already-running')
    const sql = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [DEPLOYMENT_SQL_LOCK])
    if (sql.rows[0]?.locked !== true) throw new MaintenanceError(409, 'deployment-sql-operation-still-running')
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [DEPLOYMENT_SQL_LOCK])
    await client.query("SELECT set_config('application_name',$1,false)", [token])
    const backend = await client.query<{ pid: number; backend_start: string }>(
      'SELECT pid,EXTRACT(EPOCH FROM backend_start)::text backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()')
    owner = { pid: backend.rows[0]!.pid, backendStart: backend.rows[0]!.backend_start, token }
    lifetime.signal.throwIfAborted()
  } catch (error) {
    if (!lifetime.signal.aborted) {
      try { await client.query('SELECT pg_advisory_unlock_all()') }
      catch { /* A lost connection releases its session locks; retain the acquisition error. */ }
    }
    client.removeListener('error', lost)
    client.release(true)
    throw error
  }
  let released = false
  return {
    signal: lifetime.signal,
    owner,
    async [Symbol.asyncDispose]() {
      if (released) return
      released = true
      try {
        if (!lifetime.signal.aborted) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [DEPLOYMENT_DATA_LOCK])
      } finally {
        lifetime.abort(new Error('deployment data lease released'))
        client.removeListener('error', lost)
        client.release(true)
      }
    },
  }
}
