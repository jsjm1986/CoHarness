/** New governance captures are rebuildable; historical inventory formats retain their original coverage gaps. */
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'
import type { PeerBackupBinding,PeerBackupExporter,PeerCapture } from './peer-backup-restic.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import { validatePeerControl } from './peer-backup-control-validation.ts'
import { PeerGovernanceRebuildExporter,validateGovernanceRebuild } from './peer-governance-rebuild-export.ts'
import type { GovernanceRebuildLimits } from './peer-governance-rebuild-manifest.ts'
import type { PeerSourceWrites } from './peer-backup-source-space.ts'

async function present(file:string):Promise<boolean>{
  try{await lstat(file);return true}catch(error){if(error instanceof Error&&'code'in error&&error.code==='ENOENT')return false;throw error}
}

/** Validate the declared payload format without promoting an older inventory to complete coverage.
 * @param binding - authenticated source and destination. @param capture - immutable capture metadata.
 * @param directory - private restored files. @param signal - bounded inspection cancellation. @param limits - configured payload limits.
 */
export async function validateGovernanceBackup(binding:PeerBackupBinding,capture:PeerCapture,directory:string,signal:AbortSignal,limits:GovernanceRebuildLimits):Promise<void>{
  const [complete,legacy]=await Promise.all([present(join(directory,'governance-rebuild.json')),present(join(directory,'governance.json'))])
  if(complete&&legacy)throw new PeerBackupError(409,'peer-backup/governance-mixed-formats')
  if(complete)return validateGovernanceRebuild(binding,capture,directory,signal,limits)
  return validatePeerControl(binding,capture,directory,signal,limits)
}

/** Capture complete reviewed management state and preserve validation of previously encrypted inventory points. */
export class PeerGovernanceBackup implements PeerBackupExporter {
  private readonly current:PeerGovernanceRebuildExporter
  constructor(control:Pool,private readonly limits:GovernanceRebuildLimits,projectNameKeyFile?:string){
    this.current=new PeerGovernanceRebuildExporter(control,limits,projectNameKeyFile)
  }
  async capture(binding:PeerBackupBinding,directory:string,signal:AbortSignal,space?:PeerSourceWrites){return this.current.capture(binding,directory,signal,space)}
  async validate(binding:PeerBackupBinding,capture:PeerCapture,directory:string,signal:AbortSignal){return validateGovernanceBackup(binding,capture,directory,signal,this.limits)}
}
