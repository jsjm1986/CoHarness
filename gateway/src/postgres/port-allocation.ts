/**
 * Node-local instance-port allocation shared by PostgreSQL user, project, and
 * startup-reconciliation paths.
 * @module gateway/postgres/port-allocation
 */

import type { Queryable } from './database.ts'

/** Lowest port that can be assigned to a Gateway runtime. */
export const INSTANCE_PORT_MIN = 1024
/** Highest port that can be assigned to a Gateway runtime. */
export const INSTANCE_PORT_MAX = 65535

/**
 * Allocate the first currently unused node-local instance ports.
 *
 * Callers hold the node-scoped `gateway-port:*` transaction advisory lock while
 * invoking this function. The unique `(assigned_node_id, port)` constraint
 * remains the final guard for writers that do not use the Gateway allocator.
 * @param client - transaction-bound PostgreSQL query client.
 * @param nodeId - compute node whose ports are being reserved.
 * @param base - inclusive lower bound configured for this deployment.
 * @param count - number of ports to reserve.
 * @param nodeName - diagnostic node name used when the pool is exhausted.
 * @returns the lowest available ports in ascending order.
 */
export async function allocateInstancePorts(
  client: Queryable,
  nodeId: string,
  base: number,
  count: number,
  nodeName: string,
): Promise<number[]> {
  if (!Number.isSafeInteger(base) || base < INSTANCE_PORT_MIN || base > INSTANCE_PORT_MAX) {
    throw new RangeError(`instance port base must be an integer in ${String(INSTANCE_PORT_MIN)}..${String(INSTANCE_PORT_MAX)}`)
  }
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError('instance port allocation count must be a non-negative safe integer')
  }
  if (count > INSTANCE_PORT_MAX - base + 1) {
    throw new Error(`no instance ports remain on node ${nodeName}`)
  }
  if (count === 0) return []

  // `generate_series` is bounded by the configured port range. The anti-join
  // uses the node/port unique index and, unlike MAX(port)+1, fills holes left
  // by removed users or projects. The surrounding advisory lock makes the
  // candidate query and subsequent inserts one allocator critical section.
  const result = await client.query<{ port: number }>(`
    SELECT series.candidate::integer AS port
    FROM generate_series($2::integer, $3::integer) AS series(candidate)
    WHERE NOT EXISTS (
      SELECT 1 FROM harness.instances occupied
      WHERE occupied.assigned_node_id=$1 AND occupied.port=series.candidate
    )
    ORDER BY series.candidate
    LIMIT $4::integer`, [nodeId, base, INSTANCE_PORT_MAX, count])
  if (result.rows.length < count) {
    throw new Error(`no instance ports remain on node ${nodeName}`)
  }
  return result.rows.slice(0, count).map(row => row.port)
}
