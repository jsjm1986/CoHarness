/** Filesystem proofs protect SQLite payloads before open, on active handles and during teardown. */
import { chmod,mkdir,mkdtemp,link,readFile,readlink,realpath,rename,rm,symlink,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,expect,it } from 'vitest'
import { LocalNodeDrafts,type NodeDraftKey } from '../src/node-drafts.ts'
import { PersonalNodeIndex } from '../src/personal-index.ts'
import { NodePrivateSqliteHost } from '../src/node-private-sqlite-host.ts'
import { tightenPrivateFileAcl } from '../src/node-private-file.ts'
import type { RuntimeId,RuntimeNodeId } from '../src/runtime-catalog.ts'
const key:NodeDraftKey={organizationId:'org',nodeId:'node' as RuntimeNodeId,runtimeId:'allocation' as RuntimeId,target:'personal',userId:1,draftId:'draft',sessionId:'session'}
const owner={organizationId:key.organizationId,nodeId:key.nodeId,runtimeId:key.runtimeId,userId:key.userId}
const directories:string[]=[]
async function fixture(){const parent=await mkdtemp(join(await realpath(tmpdir()),'hgw-private-db-'));directories.push(parent);await tightenPrivateFileAcl(parent);const root=join(parent,'state'),elsewhere=join(parent,'separate');await mkdir(root,{mode:0o700});await mkdir(elsewhere,{mode:0o700});return{parent,root,elsewhere}}
afterEach(async()=>{for(const parent of directories.splice(0))await rm(parent,{recursive:true,force:true})})

it('shares one lazy local process, resumes a committed draft and directory revision, and uses no idle IPC',async()=>{
  const {root}=await fixture(),host=new NodePrivateSqliteHost(root)
  const drafts=new LocalNodeDrafts(root,host),index=new PersonalNodeIndex(root,host)
  expect(host.stats()).toEqual({pid:null,requests:0,pending:0})
  try {
    expect(await drafts.apply(key,{kind:'save',value:{revision:0,text:'retained'}})).toMatchObject({value:{revision:1}})
    const first=host.stats()
    await index.publish(owner,{generation:1,snapshot:{revision:1,items:[],conversations:[]}})
    expect(await index.contains(owner,key.sessionId)).toBe(false)
    expect(host.stats()).toMatchObject({pid:first.pid,requests:3,pending:0});expect(first.pid).not.toBeNull()
    await drafts.close();expect(host.stats().pid).toBe(first.pid)
  }finally{await Promise.all([drafts.close(),index.close()])}
  expect(host.stats().pid).toBeNull()
  const later=new LocalNodeDrafts(root)
  try{expect(await later.apply(key,{kind:'read'})).toEqual({status:200,value:{revision:1,text:'retained'}})}finally{await later.close()}
})

it.each(['drafts','personal'] as const)('rejects links in every SQLite file and its storage directories for %s',async domain=>{
  const {root,elsewhere}=await fixture(),dir=join(root,domain==='drafts'?'node-content-drafts':'personal-directory')
  await mkdir(dir,{mode:0o700});await tightenPrivateFileAcl(dir)
  const main=join(dir,domain==='drafts'?'drafts.sqlite':'index.sqlite'),outside=join(elsewhere,'proof')
  await writeFile(outside,'external untouched',{mode:0o600});await tightenPrivateFileAcl(outside)
  const host=new NodePrivateSqliteHost(root),drafts=new LocalNodeDrafts(root,host),index=new PersonalNodeIndex(root,host)
  const run=()=>domain==='drafts'?drafts.apply(key,{kind:'read'}):index.contains(owner,key.sessionId)
  try{
    for(const suffix of ['','-wal','-shm','-journal']){
      if(suffix==='-wal'){await writeFile(main,'',{mode:0o600});await tightenPrivateFileAcl(main)}
      for(const create of [link,...(process.platform==='win32'?[]:[symlink])]){
        await create(outside,main+suffix)
        try{await expect(run()).rejects.toThrow('did not complete');expect(await readFile(outside,'utf8')).toBe('external untouched')}
        finally{await rm(main+suffix)}
      }
    }
    await rm(dir,{recursive:true});await symlink(elsewhere,dir,process.platform==='win32'?'junction':'dir')
    await expect(run()).rejects.toThrow('did not complete');expect(await readFile(outside,'utf8')).toBe('external untouched')
  }finally{await Promise.all([drafts.close(),index.close()])}
})

it.skipIf(process.platform==='win32')('abandons a live SQLite process without checkpointing through a replaced directory',async()=>{
  const {root,elsewhere}=await fixture(),controlled=join(root,'node-content-drafts'),moved=join(root,'original')
  const host=new NodePrivateSqliteHost(root),store=new LocalNodeDrafts(root,host)
  try {
    await store.apply(key,{kind:'save',value:{revision:0,text:'accepted before exit'}})
    await rename(controlled,moved);await symlink(elsewhere,controlled)
    for(const suffix of ['','-wal','-shm','-journal'])await writeFile(join(elsewhere,'drafts.sqlite'+suffix),'external '+suffix)
    await expect(store.apply(key,{kind:'save',value:{revision:1,text:'must not commit'}})).rejects.toThrow('did not complete')
    expect(await readlink(controlled)).toBe(elsewhere)
    for(const suffix of ['','-wal','-shm','-journal'])expect(await readFile(join(elsewhere,'drafts.sqlite'+suffix),'utf8')).toBe('external '+suffix)
    await rm(controlled);await rename(moved,controlled)
    expect(await store.apply(key,{kind:'read'})).toEqual({status:200,value:{revision:1,text:'accepted before exit'}})
    expect(await store.apply(key,{kind:'save',value:{revision:0,text:'accepted before exit'}})).toEqual({status:200,value:{revision:1,text:'accepted before exit'}})
    await chmod(join(controlled,'drafts.sqlite'),0o644)
    await expect(store.apply(key,{kind:'read'})).rejects.toThrow('did not complete')
  } finally {await store.close()}
})

it('replays an unobserved commit after the file host exits without closing SQLite',async()=>{
  const {root}=await fixture(),host=new NodePrivateSqliteHost(root),drafts=new LocalNodeDrafts(root,host)
  try {
    const mutation={kind:'save',value:{revision:0,text:'accepted only once'}} as const
    await drafts.apply(key,mutation)
    const pid=host.stats().pid
    if(!pid)throw new Error('The isolated database host must exist after a commit.')
    process.kill(pid,'SIGKILL')
    await expect.poll(()=>host.stats().pid).toBeNull()
    expect(await drafts.apply(key,mutation)).toEqual({status:200,value:{revision:1,text:mutation.value.text}})
  }finally{await drafts.close()}
})

it.skipIf(process.platform==='win32')('reopens a legitimate predecessor SQLite schema without changing the stored identity or text',async()=>{
  const {root}=await fixture(),dir=join(root,'node-content-drafts'),file=join(dir,'drafts.sqlite')
  await mkdir(dir,{mode:0o700});await writeFile(file,'',{mode:0o600})
  const BetterSqlite=(await import('better-sqlite3')).default,previous=new BetterSqlite(file)
  try{
    previous.exec('CREATE TABLE drafts(identity TEXT PRIMARY KEY,revision INTEGER NOT NULL,text TEXT NOT NULL) WITHOUT ROWID; PRAGMA user_version=1')
    previous.prepare('INSERT INTO drafts VALUES(?,?,?)').run(JSON.stringify([key.organizationId,key.nodeId,key.userId,key.runtimeId,key.target,key.sessionId,key.draftId]),9,'previous generation')
  }finally{previous.close()}
  const drafts=new LocalNodeDrafts(root)
  try{expect(await drafts.apply(key,{kind:'read'})).toEqual({status:200,value:{revision:9,text:'previous generation'}})}finally{await drafts.close()}
})

it.skipIf(process.platform!=='linux')('rejects a real unsupported mounted filesystem before making a data directory',async()=>{
  const drafts=new LocalNodeDrafts('/proc/hgw-protected-sqlite-test-'+process.pid)
  try{await expect(drafts.apply(key,{kind:'read'})).rejects.toThrow('did not complete')}finally{await drafts.close()}
})
