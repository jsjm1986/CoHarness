/** Source-launched process holds a real kernel witness and an unfinished destructive operation. */
import { z } from 'zod'
import { resourcePolicySchema } from '@deepseek-ai/dsh-resource-budget/wire'
import { randomUUID } from 'node:crypto'
import { GatewayModelBudget } from '../../src/gateway-model-budget.ts'
import type { RuntimeStopOperationId } from '../../src/instances.ts'
import { NodeResourceBudget } from '../../src/node-resource-budget.ts'
import { createPostgresPool } from '../../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../../src/postgres/instance-repository.ts'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const inputSchema = z.object({
  context: z.object({ organizationId: z.uuid(), organizationSlug: z.string(), nodeId: z.uuid(), nodeName: z.string() }),
  config: resourcePolicySchema, directory: z.string().min(1), projectId: z.number().int().positive(), portBase: z.number().int().positive(),
}).strict()

process.once('message', raw => {
  void (async () => {
    const input = inputSchema.parse(raw), databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
    if (databaseUrl === undefined) throw new Error('Disposable PostgreSQL database required')
    const pool = createPostgresPool(databaseUrl), context = { ...input.context, pool }
    const owner = await GatewayModelBudget.open(new NodeResourceBudget(pool, context.organizationId, context.nodeId, input.config), input.directory)
    await owner.withOwnership(async processOwner => {
      const repository = new PostgresInstanceRepository(context, input.portBase)
      await repository.acquireStopLease({ kind: 'project', id: input.projectId }, randomUUID() as RuntimeStopOperationId, processOwner)
      process.send?.({ kind: 'held', ownerId: processOwner.ownerId })
      await new Promise<void>(() => { /* The parent deliberately kills this process while it owns the operation. */ })
    })
  })().catch(() => { process.stderr.write('Runtime stop owner fixture failed\n'); process.exit(1) })
})
process.send?.({ kind: 'listening' })
