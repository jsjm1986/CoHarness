/** Explicit multi-computer policy for integration scenarios exercising the managed node protocol. */

/** Enable the fixture's reviewed primary without starting or contacting a Runtime. @param context - private fixture organization and primary node. */
export async function enableFixtureTopology(context) {
  await context.pool.query(`UPDATE harness.deployment_topology SET enabled=true,primary_node_id=$2,
    primary_origin='http://127.0.0.1:1',revision=revision+1 WHERE organization_id=$1`,
  [context.organizationId,context.nodeId])
}
