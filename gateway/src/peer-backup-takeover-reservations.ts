/** Durable physical ownership of an unpublished replacement's private directories on its selected volume. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, realpath, rmdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { withDocumentDirectoryMove } from '@deepseek-ai/dsh-userdoc-local'
import { privateDirectoryState, protectedDirectoryState, tightenPrivateFileAcl } from './node-private-file.ts'
import type { NodeContentStore } from './node-content-store.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import type { PeerRecoveryOperation } from './peer-backup-takeover.ts'

type Volume = Pick<NodeContentStore,'readVolume'|'writeVolume'>
type Role = 'workspace'|'runtime'|'userdoc-metadata'|'userdoc-files'
type ObjectId = {device:string;inode:string}
interface Saved extends ObjectId {
  id: string
  root_path:string
  temporary_path:string
  retained_path:string
  parent_device:string
  parent_inode:string
}
function refuse(): never { throw new PeerBackupError(409,'peer-backup/staging-ownership-unverified') }
function absent(error:unknown):boolean {return error instanceof Error && 'code' in error && error.code==='ENOENT'}
async function identity(path:string):Promise<ObjectId|undefined> {
  const info=await lstat(path,{bigint:true}).catch((error:unknown)=>{if(absent(error))return undefined;throw error})
  if(!info) return undefined
  if(!info.isDirectory() || info.isSymbolicLink() || info.ino===0n || await realpath(path)!==path) return refuse()
  return {device:String(info.dev),inode:String(info.ino)}
}
function matches(a:ObjectId|undefined,b:ObjectId):boolean {return !!a && a.device===b.device && a.inode===b.inode}
async function move(source:string,destination:string,root:Saved):Promise<void> {
  const parent=dirname(root.root_path)
  if(dirname(source)!==parent || dirname(destination)!==parent) return refuse()
  await withDocumentDirectoryMove(parent,source,destination,async handle=>{
    await handle.verify()
    if(!matches(await identity(source),root)) return refuse()
    await handle.rename()
    await handle.sync()
    if(!matches(await identity(destination),root)) return refuse()
  },{device:root.parent_device,inode:root.parent_inode})
}

export class PeerRecoveryStageRoots {
  constructor(private readonly volume:Volume, private readonly op:PeerRecoveryOperation) {}
  async reserve(role:Role,path:string):Promise<void> {
    const {op}=this, parent=dirname(path)
    if(!isAbsolute(path)||parent===path||resolve(path)!==path||await realpath(parent)!==parent
      || await protectedDirectoryState(parent,await lstat(parent))!=='protected') return refuse()
    if (await identity(path)) throw new PeerBackupError(409,'peer-backup/replacement-must-be-empty')
    const parentId=await identity(parent)
    if(!parentId) return refuse()
    const id=randomUUID()
    const temporary=await mkdtemp(join(parent,'.hgw-recovery-'+id+'-'))
    if(process.platform==='win32') await tightenPrivateFileAcl(temporary)
    const info=await identity(temporary)
    if(!info||await privateDirectoryState(temporary,await lstat(temporary))!=='private') return refuse()
    const saved:Saved={id,root_path:path,temporary_path:temporary,retained_path:join(parent,'.hgw-recovery-retained-'+id),
      parent_device:parentId.device,parent_inode:parentId.inode,...info}
    await this.volume.writeVolume(async tx=>{
        const recorded=await tx.query(`INSERT INTO node_content.recovery_stage_roots(id,operation_id,organization_id,project_id,runtime_id,node_id,volume_id,role,
          root_path,temporary_path,retained_path,parent_device,parent_inode,device,inode)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15 FROM node_content.volume WHERE organization_id=$3 AND node_id=$6 AND volume_id=$7`,
        [id,op.id,op.organizationId,op.projectId,op.runtimeId,op.targetNode,op.targetVolume,role,path,temporary,saved.retained_path,
          parentId.device,parentId.inode,info.device,info.inode])
        if(!recorded.rowCount) return refuse()
      })
    await move(temporary,path,saved)
  }

  /** Withdraw from business paths without discarding an operator's unexpected additions to an interrupted copy. */
  async withdraw():Promise<number> {
    const {op}=this
    const rows=await this.volume.readVolume(async tx=>(await tx.query<Saved>(`SELECT id,root_path,temporary_path,retained_path,
      parent_device,parent_inode,device,inode FROM node_content.recovery_stage_roots
      WHERE operation_id=$1 AND organization_id=$2 AND project_id=$3 AND runtime_id=$4 AND node_id=$5 AND volume_id=$6 AND withdrawn_at IS NULL`,
    [op.id,op.organizationId,op.projectId,op.runtimeId,op.targetNode,op.targetVolume])).rows)
    for(const root of rows) {
      if(!matches(await identity(dirname(root.root_path)),{device:root.parent_device,inode:root.parent_inode})) return refuse()
      if(!matches(await identity(root.retained_path),root)) {
        const temporary=await identity(root.temporary_path)
        const source=matches(temporary,root)?root.temporary_path:root.root_path
        if(!matches(await identity(source),root)) return refuse()
        await move(source,root.retained_path,root)
      }
      await this.volume.writeVolume(async tx=>{
        await tx.query('UPDATE node_content.recovery_stage_roots SET withdrawn_at=clock_timestamp() WHERE operation_id=$1 AND id=$2 AND withdrawn_at IS NULL',[op.id,root.id])
      })
      // Nonempty reservations remain private for inspection. Empty directories can only lose the recorded inode.
      if(matches(await identity(root.retained_path),root)) {
        await rmdir(root.retained_path).catch((error:unknown)=>{
          if(error instanceof Error && 'code' in error && ['ENOTEMPTY','EEXIST'].includes(String(error.code))) return
          throw error
        })
      }
    }
    return rows.length
  }
}

/** An unrecorded older or foreign path cannot be acknowledged as a free replacement namespace. */
export async function assertReleasedRecoveryPaths(paths:{workspace:string;runtimeHome:string}):Promise<void>{
  for(const path of [paths.workspace,paths.runtimeHome]) if(await identity(path)) return refuse()
}
