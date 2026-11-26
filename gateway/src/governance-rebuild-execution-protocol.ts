/** Governance-loss execution reviews reuse the node-local artifact and Session admission engine without inventing a data takeover. */
import type { PoolClient } from 'pg'
import type { RuntimeId } from './runtime-catalog.ts'

export interface GovernanceExecutionOperation {
  recoveryScope:'governance'
  id:string
  governanceOperationId:string
  organizationId:string
  runtimeId:RuntimeId
  ownerKind:'user'|'project'
  ownerId:string
  publicId:number
  targetNode:string
  targetVolume:string|null
  newEpoch:string
  sourceGeneration:string
  pointId:string
  phase:'review'|'released'
  suspendedEnvironmentKeys:string[]
}

/** The owner proves account/node authority, stopped writers and existing local data before artifact inspection can run. */
export interface GovernanceRecoveryExecutionAdapter {
  get(id:string):Promise<GovernanceExecutionOperation>
  authorize<T>(actor:number,work:(tx:PoolClient)=>Promise<T>,op?:GovernanceExecutionOperation):Promise<T>
  lock(tx:PoolClient,op:GovernanceExecutionOperation,stopped:boolean):Promise<void>
  nodeReady(tx:PoolClient,op:GovernanceExecutionOperation):Promise<void>
  paths(op:GovernanceExecutionOperation):Promise<{home:string;cwd:string;admin:boolean}>
  oldSessions(op:GovernanceExecutionOperation):Promise<string[]>
  selectHold(runtimeId:string):Promise<string|undefined>
}
