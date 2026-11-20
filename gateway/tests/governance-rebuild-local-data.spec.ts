/** Local binding requires actual persisted Session and scoped SQLite data; SQL authority is supplied by the owning control service. */
import { randomUUID } from 'node:crypto'
import { mkdir,mkdtemp,readFile,realpath,rename,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SESSION_FORMAT_VERSION,SessionId,SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { expect,it } from 'vitest'
import { openPersonalIndex } from '../src/personal-index-worker.ts'
import { GovernanceRebuildLocalData } from '../src/governance-rebuild-local-data.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { fixtureQueryPool } from './postgres-query-fixture.ts'

async function fixture(work:(value:{root:string;home:string;runtimeHome:string;state:string;subject:Record<string,unknown>;
  service:GovernanceRebuildLocalData;directory:DatabaseSync;append:(id:string)=>Promise<void>;id:string;signal:AbortSignal})=>Promise<void>){
  const root=await realpath(await mkdtemp(join(tmpdir(),'governance-local-'))),state=join(root,'state'),users=join(root,'users'),
    runtimeHome=join(users,'owner','dsh'),home=join(users,'owner','home'),projectRuntimesRoot=join(root,'projects'),context=new Context()
  const id=randomUUID(),organizationId=randomUUID(),nodeId=randomUUID(),runtimeId=randomUUID(),ownerId=randomUUID()
  let directory:DatabaseSync|undefined
  try{
    for(const path of [home,join(runtimeHome,'profiles','web'),join(state,'personal-directory'),projectRuntimesRoot])await mkdir(path,{recursive:true,mode:0o700})
    await writeFile(join(runtimeHome,'profiles','web','package.json'),'{"type":"module"}')
    await writeFile(join(runtimeHome,'profiles','web','cordis.patch.yml'),'[]\n')
    await context.plugin(Persistence,{root:join(runtimeHome,'sessions'),compression:'none'})
    const store:SessionPersistence=context.sessionPersistence
    const append=async(id:string)=>{
      const writer=await store.create({id:SessionId(id),cwd:home,createdAt:1,version:SESSION_FORMAT_VERSION,isSeeded:false,
        ...(id==='old-child'?{parentSession:SessionId('old-root'),delegationDepth:1,origin:'subagent' as const}:{delegationDepth:0})})
      try{await writer.append([{type:'agent/inbox/spliced',seq:SessionSeq(0),time:2,data:{target:'next-turn',start:0,
        inserted:[createUserMessage({content:[{type:'text',text:'retained pending work'}],source:{kind:'user'}})]}}])}finally{await writer.close()}
    }
    await append('old-root');await append('old-child')
    directory=new DatabaseSync(join(state,'personal-directory','index.sqlite'))
    openPersonalIndex(directory)({op:'publish',owner:{organizationId,nodeId,runtimeId,userId:7},input:{generation:4,snapshot:{revision:2,
      items:[{workspaceId:'owned',title:'Owned',path:home,sessionIds:['old-root'],createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}],conversations:[]}}})
    const subject:Record<string,unknown>={id,organizationId,nodeId,runtimeId,ownerId,ownerKind:'user',sourceGeneration:'4',writerEpoch:'4',volumeId:null,
      publicId:7,username:'owner',storageLayout:'legacy',admin:false,generation:'4',desiredState:'stopped',tokenAbsent:true}
    // Only governance query results are substituted; every local file, SQLite row and JSONL reader is real.
    const pool=fixtureQueryPool(sql=>{
      if(sql.includes('FROM harness.node_user_accounts a'))return []
      if(sql.includes('FROM harness.governance_rebuild_runtimes'))return [subject]
      throw new Error('Unexpected governance binding query')
    })
    const authority:PostgresRuntimeContext={organizationId,nodeId,pool,organizationSlug:'fixture',nodeName:'fixture'}
    const service=new GovernanceRebuildLocalData(authority,{stateRoot:state,usersRoot:users,projectRuntimesRoot},{limits:{maxRows:500,maxBytes:4<<20}})
    await work({root,home,runtimeHome,state,subject,service,directory,append,id,signal:AbortSignal.timeout(30000)})
  }finally{directory?.close();await context.fiber.dispose();await rm(root,{recursive:true,force:true})}
}

it('binds the preserved Runtime and freezes root and child Session identities while new conversations remain separate',async()=>{
  await fixture(async f=>{
    const before=await f.service.bind(f.id,undefined,f.signal)
    expect(before).toMatchObject({oldSessionCount:2,sourceGeneration:'4'})
    expect(JSON.stringify(before)).not.toContain(f.root)
    expect(await f.service.paths(f.id,before)).toEqual({home:f.runtimeHome,homePath:f.home,cwd:f.home,admin:false})
    expect(await f.service.oldSessionIds(f.id,before)).toEqual(['old-child','old-root'])
    const evidenceFile=join(f.state,'governance-rebuild-local',f.id,before.bindingId+'.json'),bytes=await readFile(evidenceFile)
    await f.append('new-conversation');f.subject.generation='5';f.subject.desiredState='running'
    expect(await f.service.oldSessionIds(f.id,before)).toEqual(['old-child','old-root'])
    expect(await readFile(evidenceFile)).toEqual(bytes)
    await expect(f.service.verify(f.id,{...before,evidenceDigest:'0'.repeat(64)})).rejects.toMatchObject({code:'peer-backup/governance-local-binding-changed'})
    await rename(f.home,f.home+'-original');await mkdir(f.home)
    await expect(f.service.paths(f.id,before)).rejects.toMatchObject({code:'peer-backup/governance-local-binding-changed'})
  })
})

it('refuses missing directories, a different scoped owner, newer local generations and omitted committed Sessions without creating data',async()=>{
  await fixture(async f=>{
    const absent=join(f.root,'must-not-create')
    await expect(f.service.bind(f.id,{homePath:absent},f.signal)).rejects.toMatchObject({code:'peer-backup/governance-local-data-missing'})
    await expect(readFile(absent)).rejects.toMatchObject({code:'ENOENT'})
    f.subject.publicId=8
    await expect(f.service.bind(f.id,undefined,f.signal)).rejects.toMatchObject({code:'peer-backup/governance-local-directory-unpublished'})
    f.subject.publicId=7
    f.directory.prepare('UPDATE publications SET generation=5').run()
    await expect(f.service.bind(f.id,undefined,f.signal)).rejects.toMatchObject({code:'peer-backup/governance-local-generation-ahead'})
    f.directory.prepare('UPDATE publications SET generation=4').run()
    f.directory.prepare("UPDATE members SET session='missing-history'").run()
    await expect(f.service.bind(f.id,undefined,f.signal)).rejects.toMatchObject({code:'peer-backup/governance-local-session-evidence-incomplete'})
    f.subject.desiredState='running'
    await expect(f.service.bind(f.id,undefined,f.signal)).rejects.toMatchObject({code:'peer-backup/governance-local-runtime-not-stopped'})
  })
})

it('requires local review of inherited control and database configuration while preserving original bytes and unrelated private values',async()=>{
  await fixture(async f=>{
    const file=join(f.runtimeHome,'.env'),original='HGW_DATABASE_URL=retired-secret-control\nPGPASSWORD=retired-secret-password\nPGP_SIGNING_KEY=retained-private-signing\nBUSINESS_OPTION=retained-private-option\n'
    await writeFile(file,original,{mode:0o600})
    await expect(f.service.bind(f.id,undefined,f.signal)).rejects.toMatchObject({code:'peer-backup/governance-local-environment-review-required',keys:['HGW_DATABASE_URL','PGPASSWORD']})
    expect(await readFile(file,'utf8')).toBe(original)
    await writeFile(file,'PGP_SIGNING_KEY=retained-private-signing\nBUSINESS_OPTION=retained-private-option\n',{mode:0o600})
    const accepted=await f.service.bind(f.id,undefined,f.signal)
    expect(accepted).toMatchObject({oldSessionCount:2})
    await writeFile(file,original,{mode:0o600})
    await expect(f.service.paths(f.id,accepted)).rejects.toMatchObject({code:'peer-backup/governance-local-environment-review-required',keys:['HGW_DATABASE_URL','PGPASSWORD']})
  })
})
