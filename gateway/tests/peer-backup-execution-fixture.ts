/** Reuse the real stopped replacement, local content volume and managed profile for execution-review assemblies. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GatewayConfig } from '../src/config.ts'
import { InstanceManager } from '../src/instances.ts'
import type { NodeContentStore } from '../src/node-content-store.ts'
import { NodeProjectMetadata } from '../src/node-content-projects.ts'
import { PeerRecoveryExecution } from '../src/peer-backup-execution.ts'
import { PeerProjectRecovery } from '../src/peer-backup-takeover.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'

/** Assemble target inspection over an already published real content volume.
 * @param input - disposable recovery state; no production profile or credential is read.
 * @returns primary administration, target inspection and the managed profile owner.
 */
export async function createRecoveryExecutionFixture(input: {
  primary: PostgresRuntimeContext; target: PostgresRuntimeContext; volume: NodeContentStore;
  cfg: GatewayConfig; operationId: string;
  beforePrepare?: () => Promise<void>;
}) {
  const { primary, target, volume, cfg, operationId } = input
  const op = await new PeerProjectRecovery(primary).get(operationId)
  const home = join(cfg.projectRuntimesRoot, String(op.publicId), 'dsh'), profile = join(home, 'profiles', 'web')
  await mkdir(profile, {recursive: true, mode: 0o700})
  // The data-only restic fixture has never booted its web profile. Install the standard CLI profile declaration explicitly.
  await writeFile(join(profile,'package.json'), JSON.stringify({name:'private-recovery-fixture',private:true,type:'module',
    dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}})+'\n', {flag:'wx',mode:0o600})
    .catch((error:unknown)=>{if(!(error instanceof Error && 'code' in error && error.code==='EEXIST')) throw error})
  const repository = new PostgresInstanceRepository(target,cfg.instancePortBase,new NodeProjectMetadata(target,volume))
  const manager = new InstanceManager(repository,cfg)
  const targetService = new PeerRecoveryExecution({context:target,config:cfg,volume,
    prepareProfile: async selected=>{await input.beforePrepare?.();await manager.prepareRecoveryProfile(selected)}})
  const adminService = new PeerRecoveryExecution({context:primary})
  return {op,manager,repository,targetService,adminService,home}
}
