/** External Gateway response fixture for the steward dry-run snapshot. */
export const name = 'steward-query-snapshot-gateway'

/**
 * Provide the external Gateway response for the dry-run snapshot.
 * @param ctx - plugin context receiving the Gateway service fixture.
 */
export function apply(ctx) {
  ctx.provide('gatewayRuntime', {
    request: async (path, init) => {
      const input = JSON.parse(init.body)
      if (path !== '/internal/runtime/steward/query' || input.dryRun !== true || input.rowLimit !== 1) {
        throw new Error('Unexpected steward snapshot request')
      }
      return new Response(JSON.stringify({
        classification: 'write', dryRun: true, columns: ['QUERY PLAN'], rows: null,
        plan: [{ 'QUERY PLAN': 'Update on projects' }], rowCount: 2, truncated: true,
      }), { headers: { 'content-type': 'application/json' } })
    },
  })
}
