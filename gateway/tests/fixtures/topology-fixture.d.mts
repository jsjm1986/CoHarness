/** Typed input for the explicit multi-computer integration fixture. @module */
import type { PostgresRuntimeContext } from '../../src/postgres/runtime-context.ts'

/**
 * Enable the reviewed primary without starting or contacting a Runtime.
 * @param context - private fixture database, organization and primary node.
 * @returns completion after the topology revision commits.
 */
export declare function enableFixtureTopology(context: Pick<PostgresRuntimeContext, 'pool' | 'organizationId' | 'nodeId'>): Promise<void>
