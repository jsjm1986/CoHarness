/** A replacement computer reserves a new workspace and the canonical Runtime home for the same project identity. */
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { GatewayConfig } from './config.ts'
import { documentIdentityLocations } from './document-storage.ts'
import { validateProjectRuntimePath } from './instances.ts'
import { peerPrivateDirectory, PeerBackupError } from './peer-backup-repository.ts'
import type { PeerRecoveryOperation } from './peer-backup-takeover.ts'
import type { PeerProjectReplacementLayout } from './peer-backup-takeover-files.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'

/** The data owner constructs all destination paths from local deployment configuration and an approved internal operation. */
export async function projectReplacementLayout(
  config: GatewayConfig,
  context: PostgresRuntimeContext,
  op: PeerRecoveryOperation,
): Promise<PeerProjectReplacementLayout> {
  if (op.organizationId !== context.organizationId || op.targetNode !== context.nodeId || !['prepared','cancelled'].includes(op.phase))
    throw new PeerBackupError(403, 'peer-backup/wrong-recovery-node')
  const base = await realpath(op.origin === 'user' ? config.userProjectsRoot : config.projectsRoot)
  const runtimes = await realpath(config.projectRuntimesRoot)
  const workspace = join(base, 'recovery-' + op.projectId + '-' + op.id)
  const root = join(runtimes, String(op.publicId))
  if (op.phase==='prepared') await peerPrivateDirectory(root)
  const parent=await lstat(root).catch((error:unknown)=>{if(error instanceof Error && 'code' in error && error.code==='ENOENT')return undefined;throw error})
  if (parent && ((await realpath(root)) !== root || !parent.isDirectory()))
    throw new PeerBackupError(409, 'peer-backup/invalid-target-files')
  return {
    workspace,
    runtimeHome: join(root, 'dsh'),
    documents: async prepareFilesRoot => {
      if (validateProjectRuntimePath(config, workspace, op.origin) !== workspace || dirname(workspace) !== base)
        throw new PeerBackupError(409, 'peer-backup/invalid-target-files')
      await mkdir(join(workspace, 'documents'), { mode: 0o700 })
      return documentIdentityLocations(config, workspace, join(workspace, 'documents'), {
        organizationId: context.organizationId,
        target: { kind: 'project', id: op.publicId },
        projectionOwner: async () => {
          // A recovery target is always fresh. An existing legacy path binding requires independent operator investigation.
          throw new PeerBackupError(409, 'peer-backup/existing-document-owner')
        },
      },prepareFilesRoot)
    },
  }
}
