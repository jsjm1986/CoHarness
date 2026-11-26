/** Immutable node-private recovery policies travel only with their owner's encrypted project data. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { writePeerSourceFile, type PeerSourceWrites } from './peer-backup-source-space.ts'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { ManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import type { NodeContentBinding } from './node-content-store.ts'
import { privateFileState } from './node-private-file.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import type { Queryable } from './postgres/database.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'

const record = z.object({ operationId: z.uuid(), reviewId: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
const dataBinding=z.object({operationId:z.uuid(),bindingId:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict()
const manifest = z.object({ version: z.literal(1), runtimeId: z.uuid(), nodeId: z.uuid(), records: z.array(record), dataBindings:z.array(dataBinding).optional() }).strict()
type PolicyRecord = z.infer<typeof record>
type Budget = { bytes: number; rows: number }
function invalid(): never { throw new PeerBackupError(409, 'peer-backup/execution-policy-missing') }
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

async function bounded(file: string, maxBytes: number, privateFile: boolean): Promise<string> {
  let entry
  try { entry = await lstat(file, { bigint: true }) } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) invalid()
    throw error
  }
  if (!entry.isFile() || entry.nlink !== 1n || entry.size > BigInt(maxBytes) || await realpath(file) !== resolve(file)) invalid()
  const handle = await open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.ino !== entry.ino || before.dev !== entry.dev || before.size !== entry.size || before.nlink !== 1n
      || privateFile && await privateFileState(file, await handle.stat(), maxBytes) !== 'private') invalid()
    const bytes = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) invalid()
      offset += read.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) invalid()
    return bytes.toString('utf8')
  } finally { await handle.close() }
}

/** Read a private immutable launch policy without following links or accepting a concurrent replacement.
 * @param file - exact node-owned policy filename. @param maxBytes - configured policy size allowance.
 * @returns the bytes whose digest must match the immutable governance receipt.
 */
export async function readRecoveryExecutionPolicy(file: string, maxBytes: number): Promise<string> {
  return bounded(file, maxBytes, true)
}

async function governancePresent(control:Queryable):Promise<boolean>{return (await control.query<{present:boolean}>("SELECT to_regclass('harness.governance_rebuild_execution_reviews') IS NOT NULL present")).rows[0]!.present}

async function bindings(control:Queryable,organization:string,node:string,runtime?:string){
  if(!await governancePresent(control))return []
  return (await control.query<z.infer<typeof dataBinding>>(`SELECT runtime_operation_id "operationId",binding_id "bindingId",evidence_digest sha256
    FROM harness.governance_rebuild_data_bindings WHERE organization_id=$1 AND node_id=$2 AND ($3::uuid IS NULL OR runtime_id=$3) ORDER BY runtime_operation_id`,[organization,node,runtime??null])).rows
}

async function records(control: Queryable, organization: string, node: string, runtime?: string, maxRows?: number): Promise<PolicyRecord[]> {
  const governance=await governancePresent(control)
  return (await control.query<PolicyRecord>(`SELECT r.operation_id "operationId",r.id "reviewId",r.policy_digest sha256
    FROM (SELECT operation_id,id,policy_digest,organization_id,target_node_id,runtime_id,created_at FROM harness.project_recovery_execution_reviews
      UNION ALL SELECT operation_id,id,policy_digest,organization_id,target_node_id,runtime_id,created_at FROM harness.personal_recovery_execution_reviews
      ${governance?'UNION ALL SELECT operation_id,id,policy_digest,organization_id,target_node_id,runtime_id,created_at FROM harness.governance_rebuild_execution_reviews':''}) r
    WHERE r.organization_id=$1 AND r.target_node_id=$2 ${runtime === undefined ? '' : 'AND r.runtime_id=$3'} ORDER BY r.operation_id,r.created_at,r.id
    ${maxRows === undefined ? '' : 'LIMIT $4'}`,
  runtime === undefined ? [organization, node] : maxRows === undefined ? [organization, node, runtime] : [organization, node, runtime, maxRows + 1])).rows
}

function policyFile(stateRoot: string, row: PolicyRecord): string {
  return join(stateRoot, 'recovery-execution', row.operationId, row.reviewId + '.json')
}

/** Select every locally owned immutable policy and refuse a maintenance backup with missing approval data.
 * @param context - authenticated node and governance database. @param stateRoot - this node's private state directory.
 * @param runtimeId - optional exact personal Runtime for a scoped native backup.
 * @returns verified files; no other computer's policy or Session identifiers are read.
 */
export async function recoveryExecutionDataRoots(context: Pick<PostgresRuntimeContext, 'organizationId' | 'nodeId'> & { pool: Queryable }, stateRoot: string, runtimeId?: string): Promise<ManagedDataPath[]> {
  if ((await context.pool.query(`SELECT FROM harness.personal_recovery_operations WHERE organization_id=$1 AND target_node_id=$2
    AND target_verified_at IS NOT NULL AND phase NOT IN('published','cancelled') AND ($3::uuid IS NULL OR runtime_id=$3) LIMIT 1`,
  [context.organizationId, context.nodeId, runtimeId ?? null])).rowCount) throw new PeerBackupError(409, 'peer-backup/personal-recovery-installation-pending')
  const selected = await records(context.pool, context.organizationId, context.nodeId, runtimeId)
  const roots: ManagedDataPath[] = []
  for (const row of selected) {
    const path = policyFile(stateRoot, row)
    if (digest(await bounded(path, 64 << 20, true)) !== row.sha256) invalid()
    roots.push({ owner: 'gateway-recovery-execution/' + row.reviewId, kind: 'file', path })
  }
  for(const row of await bindings(context.pool,context.organizationId,context.nodeId,runtimeId)){
    const path=join(stateRoot,'governance-rebuild-local',row.operationId,row.bindingId+'.json')
    if(digest(await bounded(path,64<<20,true))!==row.sha256)invalid()
    roots.push({owner:'gateway-governance-binding/'+row.bindingId,kind:'file',path})
  }
  const personal=(await context.pool.query<{id:string;sha256:string;runtime_id:string}>(`SELECT id,target_evidence_digest sha256,runtime_id FROM harness.personal_recovery_operations
    WHERE organization_id=$1 AND target_node_id=$2 AND target_verified_at IS NOT NULL AND phase<>'cancelled'
      AND ($3::uuid IS NULL OR runtime_id=$3)`,
  [context.organizationId,context.nodeId,runtimeId??null])).rows
  for(const row of personal){
    const path=join(stateRoot,'peer-personal-recovery',row.id,'evidence.json')
    const text=await bounded(path,64<<20,true)
    if(digest(text)!==row.sha256)invalid()
    roots.push({owner:'gateway-personal-recovery/'+row.id,kind:'file',path})
    const retained=z.object({retainedRecovery:z.array(z.object({key:z.string().regex(/^[a-f0-9]{64}$/u),path:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict())}).passthrough().parse(JSON.parse(text)).retainedRecovery
    for(const file of retained){
      if(file.path!==join(stateRoot,'peer-personal-recovery',row.id,'candidate','content',row.runtime_id,'recovery-private',file.key)||digest(await bounded(file.path,64<<20,true))!==file.sha256)invalid()
      roots.push({owner:'gateway-personal-retained/'+row.id+'/'+file.key,kind:'file',path:file.path})
    }
  }
  return roots
}

/** Copy only this Runtime's immutable policies into its source-encrypted backup payload.
 * @param control - organization metadata. @param binding - verified source project owner. @param stateRoot - node-private policy directory parent.
 * @param destination - isolated project payload directory. @param budget - shared export allowance. @param signal - backup cancellation.
 * @returns number of independently verified policy files.
 */
export async function exportRecoveryExecutionData(control: Queryable, binding: Pick<NodeContentBinding,'organizationId'|'nodeId'|'runtimeId'>, stateRoot: string | undefined,
  destination: string, budget: Budget, signal: AbortSignal, space?: PeerSourceWrites): Promise<number> {
  const selected = await records(control, binding.organizationId, binding.nodeId, binding.runtimeId, budget.rows)
  const dataBindings=await bindings(control,binding.organizationId,binding.nodeId,binding.runtimeId)
  if (!selected.length&&!dataBindings.length) return 0
  if (selected.length+dataBindings.length > budget.rows) throw new PeerBackupError(507, 'peer-backup/export-budget')
  if (!stateRoot) invalid()
  const directory = join(destination, 'recovery-execution')
  const create = () => mkdir(directory, { mode: 0o700 })
  if (space) await space.write(destination, 0, create)
  else await create()
  for (const row of selected) {
    signal.throwIfAborted()
    if (--budget.rows < 0) throw new PeerBackupError(507, 'peer-backup/export-budget')
    const text = await bounded(policyFile(stateRoot, row), budget.bytes, true)
    budget.bytes -= Buffer.byteLength(text)
    if (digest(text) !== row.sha256) invalid()
    await writePeerSourceFile(join(directory, row.reviewId + '.json'), text, space)
  }
  for(const row of dataBindings){
    signal.throwIfAborted();if(--budget.rows<0)throw new PeerBackupError(507,'peer-backup/export-budget')
    const text=await bounded(join(stateRoot,'governance-rebuild-local',row.operationId,row.bindingId+'.json'),budget.bytes,true)
    budget.bytes-=Buffer.byteLength(text);if(digest(text)!==row.sha256)invalid()
    await writePeerSourceFile(join(directory,row.bindingId+'.binding.json'),text,space)
  }
  const text = JSON.stringify({ version: 1, runtimeId: binding.runtimeId, nodeId: binding.nodeId, records: selected,...(dataBindings.length?{dataBindings}:{}) })
  budget.bytes -= Buffer.byteLength(text)
  if (budget.bytes < 0) throw new PeerBackupError(507, 'peer-backup/export-budget')
  await writePeerSourceFile(join(directory, 'manifest.json'), text, space)
  return selected.length+dataBindings.length
}

/** Verify encrypted policy contents without contacting the failed source or granting execution on the replacement.
 * @param destination - restored project payload directory. @param runtimeId - approved Runtime. @param nodeId - original data owner.
 * @param budget - remaining SQL/file export allowance. @param signal - recovery cancellation.
 */
export async function verifyRecoveryExecutionData(destination: string, runtimeId: string, nodeId: string, budget: Budget, signal: AbortSignal): Promise<void> {
  const directory = join(destination, 'recovery-execution')
  const text = await bounded(join(directory, 'manifest.json'), budget.bytes, false)
  budget.bytes -= Buffer.byteLength(text)
  const data = manifest.parse(JSON.parse(text))
  if (data.runtimeId !== runtimeId || data.nodeId !== nodeId || new Set(data.records.map(row => row.reviewId)).size !== data.records.length) invalid()
  for(const row of data.dataBindings??[]){
    signal.throwIfAborted();if(--budget.rows<0)throw new PeerBackupError(507,'peer-backup/export-budget')
    const text=await bounded(join(directory,row.bindingId+'.binding.json'),budget.bytes,false);budget.bytes-=Buffer.byteLength(text)
    if(digest(text)!==row.sha256)invalid()
    const saved=z.object({operationId:z.uuid(),bindingId:z.uuid(),runtimeId:z.uuid(),nodeId:z.uuid()}).passthrough().parse(JSON.parse(text))
    if(saved.operationId!==row.operationId||saved.bindingId!==row.bindingId||saved.runtimeId!==runtimeId||saved.nodeId!==nodeId)invalid()
  }
  for (const row of data.records) {
    signal.throwIfAborted()
    if (--budget.rows < 0) throw new PeerBackupError(507, 'peer-backup/export-budget')
    const body = await bounded(join(directory, row.reviewId + '.json'), budget.bytes, false)
    budget.bytes -= Buffer.byteLength(body)
    if (digest(body) !== row.sha256) invalid()
    const policy = JSON.parse(body)
    if (policy.runtimeId !== runtimeId || policy.nodeId !== nodeId || policy.operationId !== row.operationId || policy.reviewRevision !== row.reviewId) invalid()
  }
}
