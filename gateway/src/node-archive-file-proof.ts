/** Verify retired attachment bytes outside the project writer transaction. */
import { createHash } from 'node:crypto'
import { constants,type BigIntStats } from 'node:fs'
import { lstat,open,realpath } from 'node:fs/promises'
import { dirname,isAbsolute,relative,sep } from 'node:path'

export interface PendingNodeArchiveFile {
  id:string
  archive_id:string
  local_path:string
  expected_bytes?:string|null
  expected_sha256?:string|null
}
export interface NodeArchiveFileProof {
  row:PendingNodeArchiveFile
  root:string
  parent:string|null
  file:string|null
}

const identity=(s:BigIntStats)=>[s.dev,s.ino].join('/')
const version=(s:BigIntStats)=>[identity(s),s.size,s.mtimeNs,s.ctimeNs].join('/')

async function parentIdentity(root:string,path:string):Promise<string|null>{
  const suffix=relative(root,path)
  if(!isAbsolute(path)||!isAbsolute(root)||!suffix||isAbsolute(suffix)||suffix==='..'||suffix.startsWith('..'+sep))return null
  const parent=dirname(path)
  if(await realpath(root)!==root || await realpath(parent)!==parent)return null
  return identity(await lstat(root,{bigint:true}))+'|'+identity(await lstat(parent,{bigint:true}))
}

/** @param row - exact queued receipt. @param root - the published project workspace.
 * @returns repeatable path and byte evidence for the short final cleanup transaction.
 */
export async function verifyNodeArchiveFile(row:PendingNodeArchiveFile,root:string):Promise<NodeArchiveFileProof>{
  const proof:NodeArchiveFileProof={row,root,parent:null,file:null}
  if(!row.expected_sha256||!row.expected_bytes)return proof
  try{
    proof.parent=await parentIdentity(root,row.local_path)
    if(!proof.parent)return proof
    const file=await open(row.local_path,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW|constants.O_NONBLOCK))
    try{
      const before=await file.stat({bigint:true})
      if(!before.isFile() || String(before.size)!==row.expected_bytes)return proof
      const hash=createHash('sha256')
      for await(const chunk of file.createReadStream({autoClose:false}))hash.update(chunk as Buffer)
      const after=await file.stat({bigint:true})
      if(hash.digest('hex')===row.expected_sha256 && version(before)===version(after))proof.file=version(after)
    }finally{await file.close()}
  }catch(error){
    if(!proof.parent || (error as NodeJS.ErrnoException).code!=='ENOENT')proof.parent=null
  }
  return proof
}

/** @param proof - completed source-side content check. @param row - freshly claimed database receipt. @param root - current workspace.
 * @returns a deletion verdict for the same object; missing or replaced ancestors are retried.
 */
export async function confirmNodeArchiveFile(proof:NodeArchiveFileProof|undefined,row:PendingNodeArchiveFile,root:string):Promise<'missing'|'match'|'unverified'>{
  if(!proof?.parent || root!==proof.root || row.id!==proof.row.id || row.archive_id!==proof.row.archive_id ||
    row.local_path!==proof.row.local_path || row.expected_bytes!==proof.row.expected_bytes || row.expected_sha256!==proof.row.expected_sha256)return 'unverified'
  try{
    if(await parentIdentity(root,row.local_path)!==proof.parent)return 'unverified'
  }catch{return 'unverified'} // A missing or inaccessible project directory does not confirm deletion.
  try{
    const actual=await lstat(row.local_path,{bigint:true})
    return actual.isFile() && proof.file===version(actual)?'match':'unverified'
  }catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?'missing':'unverified'}
}
