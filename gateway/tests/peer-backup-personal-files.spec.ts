/** Independent personal file views restore original byte content even while the source Runtime keeps writing. */
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename,join,relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe,expect,it } from 'vitest'
import { PeerPersonalFiles,verifyPersonalFiles } from '../src/peer-backup-personal-files.ts'
import type { Queryable } from '../src/postgres/database.ts'
import { registerManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import { PeerBackupSourceSpace, type PeerSourceWrites } from '../src/peer-backup-source-space.ts'

describe('personal file recovery',()=>{
  it('rebuilds only declared files and the selected workspace from the reviewed generation, preserving an active source and its sibling',async()=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),'personal-fs-recovery-'))),source=join(root,'volume'),users=join(source,'users')
    const account=randomUUID(),runtime=randomUUID(),sibling=randomUUID(),home=join(source,'homes','a'),work=join(home,'review'),workspaceId='same'
    const owned=join(source,'sealed-runtime'),foreign=join(users,'a','runtimes',sibling,'dsh')
    const stage=join(root,'output'),conf=join(root,'scope.json'),frozen=join(root,'frozen'),dest=join(root,'result')
    const binding={organizationId:randomUUID(),sourceNodeId:randomUUID(),targetNodeId:randomUUID(),policyId:randomUUID(),scopeId:runtime,revision:1}
    const limits={maxBytes:4<<20,maxRows:100},signal=AbortSignal.timeout(20000)
    let generation='2',released=0, unavailable=false
    const control=Object.assign({} as Queryable,{query:async(sql:string)=>sql.includes('SELECT FROM harness.node_user_accounts')?{rows:[],rowCount:0}:
      {rows:[{account,username:'a',home:'/unusable-governance-placeholder',layout:'isolated',generation}],rowCount:1}})
    try {
      for(const path of [join(owned,'sessions'),join(owned,'storages'),join(owned,'profiles','web'),join(owned,'plugins','private'),foreign,work,stage])await mkdir(path,{recursive:true})
      await writeFile(join(owned,'sessions','same.jsonl'),'original committed session\n')
      await writeFile(join(foreign,'same.jsonl'),'sibling-private')
      await writeFile(join(work,'same.txt'),'selected-file')
      await writeFile(join(owned,'storages','schedule.json'),JSON.stringify({unit:{name:'schedule',version:1},global:null,tables:{tasks:{}}}))
      await writeFile(join(owned,'.env'),'private-current-key')
      await writeFile(join(owned,'profiles','web','cordis.patch.yml'),'custom: suspended\n')
      await writeFile(join(owned,'profiles','web','package.json'),'{"dependencies":{"private":"file:../../plugins/private"}}')
      await writeFile(join(owned,'plugins','private','index.js'),'export default function preservedPlugin() {}\n')
      await writeFile(join(owned,'.credentials.yaml'),'version: 1\nrecords: {}\n')
      for(const [owner,path] of [['@deepseek-ai/dsh-session-persistence-jsonl',join(owned,'sessions')],['@deepseek-ai/dsh-storage-json',join(owned,'storages')],['unknown-plugin',foreign]]){
        registerManagedDataPath({owner:owner!,kind:'directory',path:path!},join(owned,'managed-data.jsonl'))
      }
      for(const name of ['package.json','cordis.patch.yml'])registerManagedDataPath({owner:'app-boot',kind:'file',path:join(owned,'profiles','web',name)},join(owned,'managed-data.jsonl'))
      registerManagedDataPath({owner:'@deepseek-ai/dsh-credentials-local',kind:'file',path:join(owned,'.credentials.yaml')},join(owned,'managed-data.jsonl'))
      await writeFile(conf,JSON.stringify({version:1,organizationId:binding.organizationId,nodeId:binding.sourceNodeId,provider:'btrfs',
        runtimes:[{runtimeId:runtime,source,snapshotDirectory:root,workspaces:[{id:workspaceId,path:work}],artifacts:[{path:join(owned,'plugins','private'),kind:'directory'}]}]}),{mode:0o600})
      const db=new DatabaseSync(join(stage,'personal.sqlite'))
      db.exec('CREATE TABLE records(collection TEXT,body TEXT)')
      db.prepare("INSERT INTO records VALUES('workspaces',?)").run(JSON.stringify({id:workspaceId,value:JSON.stringify({workspaceId,path:work})}))
      db.close()
      const exporter=new PeerPersonalFiles(control,conf,1000,async target=>{
        expect(target).toEqual({kind:'user',id:32,runtimeId:runtime})
        if(unavailable)throw new Error('sealed binding unavailable')
        return {homePath:home,dshHome:owned}
      },undefined,async()=>{
        await cp(source,frozen,{recursive:true});await writeFile(join(owned,'sessions','same.jsonl'),'continued source work\n')
        return {root:frozen,map:path=>join(frozen,relative(source,path)),confirm:async()=>{},release:async()=>{released++;await rm(frozen,{recursive:true})}}
      })
      const saved=await exporter.capture(binding,32,stage,limits,signal)
      expect(saved?.gaps).toEqual(expect.arrayContaining(['plugin:unverified-managed-paths','files:account-documents-outside-checkpoint']))
      expect(saved?.gaps).not.toContain('files:unselected-personal-workspaces')
      expect(saved?.gaps).not.toContain('plugin:profile-unavailable')
      expect(released).toBe(1)
      await verifyPersonalFiles(binding,32,saved!.receipt,stage,limits,signal,undefined,dest)
      expect(await readFile(join(dest,runtime,'runtime','sessions','same.jsonl'),'utf8')).toBe('original committed session\n')
      expect(await readFile(join(owned,'sessions','same.jsonl'),'utf8')).toBe('continued source work\n')
      expect(await readFile(join(dest,runtime,'runtime','profiles','web','cordis.patch.yml'),'utf8')).toBe('custom: suspended\n')
      expect(await readFile(join(dest,runtime,'runtime','plugins','private','index.js'),'utf8')).toBe('export default function preservedPlugin() {}\n')
      expect(await readFile(join(dest,runtime,'runtime','.credentials.yaml'),'utf8')).toBe('version: 1\nrecords: {}\n')
      const maps=JSON.parse(await readFile(join(stage,'personal-roots.json'),'utf8')) as {roots:{key:string;role:string;source:string}[]}
      expect(maps.roots.map(x=>basename(x.source))).not.toContain(sibling)
      expect(await readFile(join(dest,runtime,'workspace',maps.roots.find(x=>x.role==='workspace')!.key,'same.txt'),'utf8')).toBe('selected-file')
      expect(await readFile(join(dest,runtime,'runtime','.env'),'utf8')).toBe(await readFile(join(owned,'.env'),'utf8'))
      let free=8<<20,copied=0
      const owner=new PeerBackupSourceSpace(8192,async()=>({bavail:BigInt(Math.floor(free/4096)),bsize:4096n}))
      const shared=owner.operation(signal)
      const limited:PeerSourceWrites={...shared,write:(path,bytes,write,entries)=>shared.write(path,bytes,async()=>{
        const result=await write();if(bytes>0){copied+=bytes;free=8192}return result
      },entries)}
      const limitedDestination=join(root,'limited')
      await expect(verifyPersonalFiles(binding,32,saved!.receipt,stage,{...limits,space:limited},signal,undefined,limitedDestination))
        .rejects.toMatchObject({status:507,code:'peer-backup/source-capacity'})
      expect(copied).toBeGreaterThan(0)
      expect(await readdir(root)).not.toContain('limited')
      expect(await readFile(join(owned,'sessions','same.jsonl'),'utf8')).toBe('continued source work\n')
      let entered!:()=>void,release!:()=>void
      const started=new Promise<void>(done=>{entered=done}),proceed=new Promise<void>(done=>{release=done})
      free=1<<20
      const otherPolicy=owner.operation(signal).write(root,8192,async()=>{entered();await proceed;free=8192})
      await started
      const concurrent=expect(verifyPersonalFiles(binding,32,saved!.receipt,stage,{...limits,space:owner.operation(signal)},signal,undefined,limitedDestination))
        .rejects.toMatchObject({status:507,code:'peer-backup/source-capacity'})
      release();await otherPolicy;await concurrent
      expect(await readdir(root)).not.toContain('limited')
      unavailable=true
      await expect(exporter.capture(binding,32,stage,limits,signal)).rejects.toThrow('sealed binding unavailable')
      expect(released).toBe(1)
      await expect(verifyPersonalFiles({...binding,sourceNodeId:randomUUID()},32,saved!.receipt,stage,limits,signal)).rejects.toThrow()
      await expect(verifyPersonalFiles(binding,33,saved!.receipt,stage,limits,signal)).rejects.toThrow()
      await expect(verifyPersonalFiles(binding,32,saved!.receipt,stage,limits,signal,undefined,dest)).rejects.toMatchObject({code:'EEXIST'})
      await writeFile(join(stage,'personal-files','00000000.data'),'tampered')
      await expect(verifyPersonalFiles(binding,32,saved!.receipt,stage,limits,signal)).rejects.toThrow()
      generation='3'
    }finally{await rm(root,{recursive:true,force:true})}
  })
})
