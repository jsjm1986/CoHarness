/** Source-launched child: real kernel ownership, PostgreSQL reservation and an unfinished HTTP model response. */
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import { z } from 'zod'
import { resourcePolicySchema } from '@deepseek-ai/dsh-resource-budget/wire'
import { GatewayModelBudget } from '../../src/gateway-model-budget.ts'
import { NodeResourceBudget } from '../../src/node-resource-budget.ts'
import { createPostgresPool } from '../../src/postgres/database.ts'
import { PostgresProgressUsage } from '../../src/postgres/progress-usage.ts'
import { PostgresModelGovernanceService } from '../../src/postgres/model-governance-service.ts'
import { OrganizationModelCredentialCipher } from '../../src/organization-model-credentials.ts'

const inputSchema = z.object({
  context: z.object({ organizationId: z.uuid(), organizationSlug: z.string(), nodeId: z.uuid(), nodeName: z.string() }),
  config: resourcePolicySchema, directory: z.string().min(1), projectId: z.number().int().positive(), internalProjectId: z.uuid(), url: z.url(),
}).strict()

process.once('message', raw => {
  void (async () => {
    const input = inputSchema.parse(raw), databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
    if (databaseUrl === undefined) throw new Error('Disposable database required')
    if (new URL(input.url).hostname !== '127.0.0.1') throw new Error('Private loopback model endpoint required')
    const pool = createPostgresPool(databaseUrl), context = { ...input.context, pool }
    const budget = new NodeResourceBudget(pool, context.organizationId, context.nodeId, input.config)
    const owner = await GatewayModelBudget.open(budget, input.directory)
    const governance = new PostgresModelGovernanceService(context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 35)))
    const usage = new PostgresProgressUsage(context, governance, 1)
    process.send?.({ kind: 'ready' })
    process.once('message', () => {
      void owner.run({ actorId: 0, projectId: input.projectId, signal: new AbortController().signal }, async (signal, operationId) => {
        const request = { model: 'chat', messages: [{ role: 'user' as const, content: 'Synthetic crash-recovery request.' }],
          max_tokens: 128, temperature: 0.2, stream: false as const }
        await usage.prepare({ projectId: input.projectId, internalProjectId: input.internalProjectId, actorId: 0, operationId,
          provider: 'org-crash', credentialSource: 'organization', request })
        const response = await fetch(input.url, { method: 'POST', body: JSON.stringify(request), signal })
        await response.text()
      }).catch(() => { process.stderr.write('Gateway model request fixture failed\n'); process.exit(1) })
    })
  })().catch(() => { process.stderr.write('Gateway model owner fixture failed\n'); process.exit(1) })
})
process.send?.({ kind: 'listening' })
