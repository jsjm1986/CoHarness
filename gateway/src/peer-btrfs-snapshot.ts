/** Read-only Btrfs subvolume snapshots taken on the source node under its service account. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat,opendir,readFile,readlink,realpath,rename } from 'node:fs/promises'
import { isAbsolute,join,relative,resolve,sep } from 'node:path'
import { promisify } from 'node:util'
import { privateDirectoryState,syncStateDirectory } from './node-private-file.ts'
import { PeerBackupError } from './peer-backup-repository.ts'

const execute=promisify(execFile)
const denied=()=>new PeerBackupError(503,'peer-backup/btrfs-snapshot-unavailable')
function inside(root:string,candidate:string):boolean {
  const rest=relative(root,candidate)
  return rest==='' || rest!=='..'&&!rest.startsWith('..'+sep)&&!isAbsolute(rest)
}

/** A live path bound to one directory within the project snapshot subvolume. */
export interface PeerBtrfsBindMount {
  readonly path:string
  readonly sourcePath:string
}

async function mountTable() {
  const raw=await readFile('/proc/self/mountinfo','utf8')
  return raw.trim().split('\n').map(line=>{
    const fields=line.split(' ')
    const path=fields[4]!.replace(/\\([0-7]{3})/gu,(_,oct:string)=>String.fromCharCode(parseInt(oct,8)))
    return {id:fields[0]!,path}
  })
}

async function verifyBindMounts(source:string,staging:string,binds:readonly PeerBtrfsBindMount[]):Promise<string> {
  if(!binds.length)return ''
  const mounts=await mountTable()
  const overlap=(left:string,right:string)=>inside(left,right)||inside(right,left)
  const proof:string[][]=[]
  for(const bind of binds) {
    if(!isAbsolute(bind.path)||!isAbsolute(bind.sourcePath)||overlap(bind.path,source)||overlap(bind.path,staging)||
      !inside(source,bind.sourcePath)||bind.sourcePath===source||
      binds.some(other=>other!==bind&&(overlap(other.path,bind.path)||overlap(other.sourcePath,bind.sourcePath))))throw denied()
    if(await realpath(bind.path)!==bind.path || await realpath(bind.sourcePath)!==bind.sourcePath)throw denied()
    const exact=mounts.filter(mount=>mount.path===bind.path)
    if(exact.length!==1)throw denied()
    if(mounts.some(mount=>mount.path!==bind.path&&inside(bind.path,mount.path)))throw new PeerBackupError(409,'peer-backup/nested-filesystem')
    const [live,physical]=await Promise.all([lstat(bind.path,{bigint:true}),lstat(bind.sourcePath,{bigint:true})])
    if(!live.isDirectory()||!physical.isDirectory()||live.dev!==physical.dev||live.ino!==physical.ino)throw denied()
    proof.push([exact[0]!.id,String(live.dev),String(live.ino)])
  }
  return JSON.stringify(proof)
}

async function witness(path:string,timeout:number,signal?:AbortSignal) {
  const binary=resolve(import.meta.dirname,'../libexec/hgw-btrfs-witness')
  const stat=await lstat(binary)
  if(!stat.isFile() || await realpath(binary)!==binary || stat.uid!==0 && stat.uid!==process.getuid?.() || (stat.mode&0o022)!==0)throw denied()
  const {stdout}=await execute(binary,[path],{timeout,signal,maxBuffer:512,env:{LC_ALL:'C'}})
  const row=/^([a-f0-9-]{36}) ([a-f0-9-]{36}) ([a-f0-9-]{36}) ([1-9]\d*) ([01]) ([01])$/u.exec(stdout.trim())
  if(!row)throw denied()
  return {uuid:row[1]!,parent:row[2]!,filesystem:row[3]!,device:row[4]!,readonly:row[5]==='1',nested:row[6]==='1'}
}

/** Verify the stable volume and subvolume identities and their current Linux device number.
 * @param source - canonical source subvolume.
 * @param staging - separate snapshot directory.
 * @param binds - actual live mounts of directories in source.
 * @param timeout - kernel probe command deadline.
 * @param signal - owner cancellation.
 * @returns an identity that distinguishes a remount from a replacement volume.
 */
export async function attestPeerBtrfsSource(source:string,staging:string,binds:readonly PeerBtrfsBindMount[],timeout:number,signal:AbortSignal) {
  if(process.platform!=='linux' || await realpath(source)!==source || await realpath(staging)!==staging)throw denied()
  const volume=await witness(source,timeout,signal)
  if(volume.readonly||volume.nested)throw denied()
  await verifyBindMounts(source,staging,binds)
  return {filesystem:volume.filesystem,subvolume:volume.uuid,device:volume.device}
}

const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const decimal = /^[1-9][0-9]*$/u

async function processStart(pid:number):Promise<string|undefined> {
  let stat:string
  try { stat=await readFile('/proc/'+pid+'/stat','utf8') }
  catch(error) {
    if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error
    try { process.kill(pid,0) } catch(probe) {
      if ((probe as NodeJS.ErrnoException).code==='ESRCH') return undefined
      throw probe
    }
    throw denied()
  }
  // The parenthesized command name can itself contain spaces and closing parentheses.
  const end=stat.lastIndexOf(') ')
  const ticks=stat.slice(end+2).split(' ')[19]
  if(end<0 || !ticks || !/^\d+$/u.test(ticks))throw denied()
  return ticks
}

async function captureOwner() {
  const boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()
  const namespace=/^pid:\[(\d+)\]$/u.exec(await readlink('/proc/self/ns/pid'))?.[1]
  const start=await processStart(process.pid)
  if(!guid.test(boot)||!namespace||start===undefined)throw denied()
  return {boot,namespace,start}
}

/** Create a snapshot outside the source subvolume, refusing nested volumes that Btrfs would omit.
 * @param source - configured canonical Btrfs subvolume, containing the approved live roots.
 * @param staging - private directory on the same filesystem, outside the source and all backup roots.
 * @param timeout - operating system command deadline. @param signal - current background job lifetime.
 * @param binds - optional live bind mounts whose directory identities must match their configured subvolume locations.
 * @returns a frozen filesystem path, source identity and an idempotent release operation.
 */
export async function openPeerBtrfsSnapshot(source:string,staging:string,timeout:number,signal:AbortSignal,binds:readonly PeerBtrfsBindMount[]=[]){
  if(process.platform!=='linux' || !isAbsolute(source)||!isAbsolute(staging)||source===sep||inside(source,staging)||inside(staging,source))throw denied()
  if(await realpath(source)!==source || await realpath(staging)!==staging || await privateDirectoryState(staging,await lstat(staging))!=='private')throw denied()
  const binary='/usr/bin/btrfs'
  const executable=await lstat(binary)
  if(!executable.isFile()||executable.uid!==0||(executable.mode&0o022)!==0)throw denied()
  const call=async(argv:string[],lifetime?:AbortSignal)=>(await execute(binary,argv,{timeout,signal:lifetime,maxBuffer:128*1024,
    windowsHide:true,env:{LC_ALL:'C',PATH:'/usr/sbin:/usr/bin:/sbin:/bin'}})).stdout
  const volume=await witness(source,timeout,signal),sourceUuid=volume.uuid
  if(volume.nested)throw new PeerBackupError(409,'peer-backup/nested-filesystem')
  if((await mountTable()).some(mount=>mount.path!==source && inside(source,mount.path)))throw new PeerBackupError(409,'peer-backup/nested-filesystem')
  const bindProof=await verifyBindMounts(source,staging,binds)
  const physicalPath=(original:string):string|undefined=>{
    if(resolve(original)!==original)return undefined
    if(inside(source,original))return original
    const bind=binds.find(item=>inside(item.path,original))
    return bind&&join(bind.sourcePath,relative(bind.path,original))
  }
  const owner=await captureOwner()
  const prefix='hgw-peer-v1.'+sourceUuid+'.'

  async function removeOwned(original:string,expected:string|undefined) {
    let path=original
    try {
      const captured=await witness(path,timeout)
      if(captured.parent!==sourceUuid || captured.filesystem!==volume.filesystem || captured.nested ||
        (expected ? captured.uuid!==expected : !captured.readonly))throw denied()
      if(!expected){
        // Pin the kernel snapshot UUID in its name before temporarily making it deletable.
        const sealed=path+'.'+captured.uuid
        await rename(path,sealed)
        path=sealed
        await syncStateDirectory(staging)
      }
      if(captured.readonly)await call(['property','set','-ts',path,'ro','false'])
      const ready=await witness(path,timeout)
      if(ready.uuid!==captured.uuid || ready.parent!==sourceUuid || ready.filesystem!==volume.filesystem || ready.readonly || ready.nested)throw denied()
      await call(['subvolume','delete',path])
    } catch(error) {
      // Another backup may have finished reaping the same dead owner's view.
      try {await lstat(path)} catch(missing) {if((missing as NodeJS.ErrnoException).code==='ENOENT')return;throw missing}
      throw error
    }
  }

  const entries=await opendir(staging)
  for await(const entry of entries){
    signal.throwIfAborted()
    if(!entry.isDirectory() || !entry.name.startsWith(prefix))continue
    const parts=entry.name.slice(prefix.length).split('.')
    const [boot,namespace,pid,start,job,id]=parts
    if(!boot||!namespace||!pid||!start||!job||parts.length<5||parts.length>6||!guid.test(boot)||
      !decimal.test(namespace)||!decimal.test(pid)||Number(pid)>2147483647||!/^\d+$/u.test(start)||!guid.test(job)||(id!==undefined&&!guid.test(id)))continue
    // A Gateway in a different PID namespace cannot prove that this writer has exited.
    if(namespace!==owner.namespace || await processStart(Number(pid))===start)continue
    await removeOwned(join(staging,entry.name),id)
  }

  let path=join(staging,prefix+[owner.boot,owner.namespace,process.pid,owner.start,randomUUID()].join('.'))
  let snapshotUuid:string|undefined, pendingRelease:Promise<void>|undefined, released=false
  const release=()=>pendingRelease??=(async()=>{
    if(!released){await removeOwned(path,snapshotUuid);released=true}
  })().finally(()=>{pendingRelease=undefined})
  try {
    await call(['subvolume','snapshot','-r',source,path],signal)
    const captured=await witness(path,timeout,signal)
    const sourceAfter=await witness(source,timeout,signal)
    if(captured.uuid===sourceUuid || captured.parent!==sourceUuid || !captured.readonly || captured.nested || captured.filesystem!==volume.filesystem ||
      sourceAfter.uuid!==sourceUuid || sourceAfter.filesystem!==volume.filesystem || sourceAfter.device!==volume.device || sourceAfter.nested||
      await verifyBindMounts(source,staging,binds)!==bindProof)throw denied()
    const sealed=path+'.'+captured.uuid
    await rename(path,sealed)
    path=sealed
    snapshotUuid=captured.uuid
    await syncStateDirectory(staging)
    const devices={filesystem:volume.filesystem,sourceVolume:sourceUuid,snapshotVolume:snapshotUuid,sourceDevice:volume.device,snapshotDevice:captured.device}
    const confirm=async()=>{
      const held=await witness(path,timeout,signal)
      if(held.uuid!==snapshotUuid || held.device!==captured.device || held.parent!==sourceUuid || held.filesystem!==volume.filesystem || !held.readonly||
        await verifyBindMounts(source,staging,binds)!==bindProof)throw denied()
    }
    return {root:path,id:snapshotUuid,devices,confirm,covers:(original:string)=>physicalPath(original)!==undefined,map:(original:string)=>{
      const physical=physicalPath(original)
      if(physical===undefined)throw new PeerBackupError(409,'peer-backup/source-outside-snapshot')
      return join(path,relative(source,physical))
    },release}
  } catch(error) {
    try {await release()} catch(cleanup) {throw new AggregateError([error,cleanup],'Project snapshot capture and release failed')}
    throw error
  }
}
