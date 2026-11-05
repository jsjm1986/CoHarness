/** Bind SQLite’s database and journaling files to a protected local directory for the lifetime of a file host. */
import { openNodeSqlite,type NodeSqlite } from './node-sqlite-driver.ts'
import { constants,lstatSync,realpathSync,type BigIntStats } from 'node:fs'
import { lstat,mkdir,open } from 'node:fs/promises'
import { dirname,isAbsolute,join,parse,relative,resolve,sep } from 'node:path'
import { windowsSecurityId } from './node-windows-security-id.ts'
import { localMountIdentity } from './node-local-mount.ts'
import { privateDirectoryState,privateFileState,protectedDirectoryState } from './node-private-file.ts'

interface ObjectId {dev:bigint;ino:bigint;mode:bigint;uid:bigint;nlink:bigint;ctimeNs:bigint;mtimeNs:bigint}
const suffixes=['','-wal','-shm','-journal'] as const
function same(a:ObjectId,b:ObjectId):boolean{return a.dev===b.dev&&a.ino===b.ino&&a.mode===b.mode&&a.uid===b.uid}
function refused():never {throw new Error('Node-private SQLite storage is unavailable.')}
function safeStateRoot(raw:string):string {
  if(!isAbsolute(raw)||resolve(raw)!==raw||process.platform==='win32'&&raw.startsWith('\\\\'))refused()
  // Darwin supplies these system-owned aliases in TMPDIR and in existing Gateway settings.
  if(process.platform==='darwin')for(const alias of ['var','tmp','etc']){
    const top='/'+alias
    if((raw===top||raw.startsWith(top+'/'))&&lstatSync(top).isSymbolicLink()){
      if(lstatSync(top).uid!==0||realpathSync(top)!=='/private/'+alias)refused()
      return join('/private',raw)
    }
  }
  return raw
}
function normal(path:string,st:BigIntStats,kind:'directory'|'file',canonical=true):void {
  if(st.isSymbolicLink()||canonical&&relative(path,realpathSync.native(path))!==''||st.ino===0n||
    (kind==='file'?!st.isFile()||st.nlink!==1n:!st.isDirectory()))refused()
}
const permissions=(st:BigIntStats)=>({mode:Number(st.mode),uid:Number(st.uid),size:Number(st.size),isFile:()=>st.isFile(),isDirectory:()=>st.isDirectory()})

/** Only the dedicated database subprocess owns an open SQLite handle. Unsafe closure must let the kernel release its descriptors. */
export class NodePrivateSqlite {
  private readonly ancestors=new Map<string,BigIntStats>()
  private readonly acl=new Map<string,string>()
  private readonly files=new Map<string,BigIntStats>()
  private file=''
  private volume=''
  private nativeAclReads=0
  private mounts=0
  private permissions=0
  private db?:NodeSqlite
  private compromised=false
  constructor(private readonly root:string,private readonly directory:string,private readonly name:string,private readonly timeout:number){}

  /** Whether an already opened handle can still be closed through the path SQLite retained. */
  get unsafeClose():boolean{return this.compromised&&this.db!==undefined}

  /** @returns audited OS proof counts, without file names or data. */
  proofCounts(){return {mounts:this.mounts,permissions:this.permissions,nativeAclReads:this.nativeAclReads}}

  private aclId(path:string){this.nativeAclReads++;return windowsSecurityId(path)}

  private async mount(path:string){this.mounts++; return localMountIdentity(path,this.timeout)}

  private async directoryVerdict(path:string,st:BigIntStats,privateDir:boolean):Promise<void>{
    normal(path,st,'directory')
    if(st.uid!==0n&&st.uid!==BigInt(process.getuid!()))refused()
    const info=permissions(st)
    this.permissions++
    if(privateDir){if(await privateDirectoryState(path,info)!=='private')refused()}
    else if(st.uid===0n&&(st.mode&0o1000n)!==0n)return
    else if(await protectedDirectoryState(path,info)!=='protected')refused()
  }

  private async windowsProof(provision:boolean):Promise<void>{
    const {windowsSqliteProof}=await import('./node-private-sqlite-windows.ts')
    this.mounts++;this.permissions++
    const dir=dirname(this.file)
    const aclPaths=[...this.ancestors.keys(),...suffixes.map(s=>this.file+s)]
    const evidence=new Map<string,string>()
    for(const path of aclPaths){
      const st=lstatSync(path,{bigint:true,throwIfNoEntry:false})
      if(!st)continue
      normal(path,st,this.ancestors.has(path)?'directory':'file',false);evidence.set(path,this.aclId(path))
    }
    const proof=await windowsSqliteProof(dir,this.name,provision,this.timeout)
    if(this.volume&&this.volume!==proof.volume)refused()
    this.volume=proof.volume
    for(const path of aclPaths){
      const st=lstatSync(path,{bigint:true,throwIfNoEntry:false});if(!st){this.acl.delete(path);continue}
      const id=this.aclId(path),prior=evidence.get(path)
      if(prior!==undefined&&prior!==id)refused()
      this.acl.set(path,id)
    }
    for(const suffix of suffixes){
      const path=this.file+suffix,st=lstatSync(path,{bigint:true,throwIfNoEntry:false})
      if(!st){if(proof.files.includes(suffix))refused();continue}
      normal(path,st,'file')
      if(!proof.files.includes(suffix)||st.dev!==lstatSync(dir,{bigint:true}).dev)refused()
      const previous=this.files.get(path);if(previous&&!same(previous,st))refused()
      this.files.set(path,st)
    }
  }

  private async prepare():Promise<void>{
    this.ancestors.clear();this.acl.clear();this.files.clear();this.volume=''
    const root=safeStateRoot(this.root),dir=join(root,this.directory),parts:string[]=[]
    if(root===parse(root).root)refused()
    let cursor=dir
    for(;;){parts.unshift(cursor);if(cursor===dirname(cursor))break;cursor=dirname(cursor)}
    this.file=join(dir,this.name)
    if(process.platform==='win32'){
      const existing=new Map<string,BigIntStats>()
      for(const path of parts){
        const st=lstatSync(path,{bigint:true,throwIfNoEntry:false})
        if(!st)break
        normal(path,st,'directory',false);existing.set(path,st);this.ancestors.set(path,st)
      }
      await this.windowsProof(true)
      for(const path of parts){
        const st=lstatSync(path,{bigint:true}),previous=existing.get(path)
        normal(path,st,'directory');if(previous&&!same(previous,st))refused()
        this.ancestors.set(path,st)
        if(!this.acl.has(path))this.acl.set(path,this.aclId(path))
      }
    }else{
      for(const path of parts){
        let st=lstatSync(path,{bigint:true,throwIfNoEntry:false})
        if(!st){
          // Prove the existing parent before creating anything on a potentially remote mount.
          await this.mount(dirname(path))
          try{await mkdir(path,{mode:0o700})}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
          st=await lstat(path,{bigint:true})
        }
        const privateDir=path===dir
        await this.directoryVerdict(path,st,privateDir)
        this.ancestors.set(path,st)
      }
      this.volume=await this.mount(dir)
      const flags=constants.O_NOFOLLOW|constants.O_NONBLOCK
      if(!lstatSync(this.file,{throwIfNoEntry:false})){
        try{
          const handle=await open(this.file,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|flags,0o600)
          try{const opened=await handle.stat({bigint:true}),named=await lstat(this.file,{bigint:true});if(!same(opened,named))refused()}
          finally{await handle.close()}
        }catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
      }
    }
    await this.inspect(false)
    const db=openNodeSqlite(this.file)
    this.db=db
    db.exec('PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000')
    await this.inspect(true)
  }

  private async inspect(ownWrite:boolean):Promise<void>{
    try{
      let verifyWindows=false
      const directory=this.ancestors.get(dirname(this.file))!
      for(const [path,previous] of this.ancestors){
        const st=lstatSync(path,{bigint:true});normal(path,st,'directory',false)
        if(!same(previous,st))refused()
        if(process.platform==='win32'&&previous.ctimeNs!==st.ctimeNs&&this.aclId(path)!==this.acl.get(path))verifyWindows=true
        this.ancestors.set(path,st)
      }
      for(const suffix of suffixes){
        const path=this.file+suffix,st=lstatSync(path,{bigint:true,throwIfNoEntry:false}),previous=this.files.get(path)
        if(!st){if(!suffix||previous&&!ownWrite)refused();this.files.delete(path);continue}
        normal(path,st,'file',!previous)
        if(st.dev!==directory.dev||previous&&!same(previous,st))refused()
        if(!previous || process.platform==='win32'&&previous.ctimeNs!==st.ctimeNs&&this.aclId(path)!==this.acl.get(path)) {
          if(process.platform==='win32'){
            // SQLite may create journals during its own transaction. Compare their actual owner and DACL with the verified database.
            const id=this.aclId(path)
            if(!previous&&ownWrite&&suffix&&id===this.acl.get(this.file))this.acl.set(path,id)
            else verifyWindows=true
          }else {
            if(await this.mount(path)!==this.volume)refused();this.permissions++
            if(await privateFileState(path,permissions(st),Number.MAX_SAFE_INTEGER)!=='private')refused()
          }
        } else if(process.platform!=='win32'&&(st.uid!==BigInt(process.getuid!())||(st.mode&0o077n)!==0n))refused()
        this.files.set(path,st)
      }
      if(verifyWindows)await this.windowsProof(false)
    }catch(error){this.compromised=!!this.db;throw error}
  }

  /** @param work - synchronous SQLite work in the serialized file host. @returns only after the files and their sidecars are checked again. */
  async run<T>(work:(db:NodeSqlite)=>T):Promise<T>{
    if(this.compromised)refused()
    if(!this.db)await this.prepare();else await this.inspect(false)
    try{return work(this.db!)}finally{await this.inspect(true)}
  }

  /** Close only handles whose directory and journaling identities remain valid. */
  async close():Promise<void>{
    if(!this.db)return
    if(this.compromised)refused()
    await this.inspect(false)
    this.db.close();this.db=undefined
  }
}
