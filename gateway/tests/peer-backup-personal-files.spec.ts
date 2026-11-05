/** Independent personal file views restore original byte content even while the source Runtime keeps writing. */
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename,join,relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe,expect,it } from 'vitest'
import { PeerPersonalFiles,verifyPersonalFiles } from '../src/peer-backup-personal-files.ts'
import type { Queryable } from '../src/postgres/database.ts'
import { registerManagedDataPath } from '@deepseek-ai/dsh-managed-data'

describe('personal file recovery',()=>{
  it('rebuilds only declared files and the selected workspace from the reviewed generation, preserving an active source and its sibling',async()=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),'personal-fs-recovery-'))),source=join(root,'volume'),users=join(source,'users')
    const account=randomUUID(),runtime=randomUUID(),sibling=randomUUID(),home=join(source,'homes','a'),work=join(home,'review'),workspaceId='same'
    const owned=join(users,'a','runtimes',runtime,'dsh'),foreign=join(users,'a','runtimes',sibling,'dsh')
    const stage=join(root,'output'),conf=join(root,'scope.json'),frozen=join(root,'frozen'),dest=join(root,'result')
    const binding={organizationId:randomUUID(),sourceNodeId:randomUUID(),targetNodeId:randomUUID(),policyId:randomUUID(),scopeId:runtime,revision:1}
    const limits={maxBytes:4<<20,maxRows:100},signal=AbortSignal.timeout(20000)
    let generation='2',released=0
    const control={query:async(sql:string)=>sql.includes('SELECT FROM harness.node_user_accounts')?{rows:[],rowCount:0}:
      {rows:[{account,username:'a',home,layout:'isolated',generation}],rowCount:1}} as unknown as Queryable
    try {
      for(const path of [join(owned,'sessions'),join(owned,'storages'),foreign,work,stage])await mkdir(path,{recursive:true})
      await writeFile(join(owned,'sessions','same.jsonl'),'original committed session\n')
      await writeFile(join(foreign,'same.jsonl'),'sibling-private')
      await writeFile(join(work,'same.txt'),'selected-file')
      await writeFile(join(owned,'storages','schedule.json'),JSON.stringify({unit:{name:'schedule',version:1},global:null,tables:{tasks:{}}}))
      await writeFile(join(owned,'.env'),'private-current-key')
      for(const [owner,path] of [['@deepseek-ai/dsh-session-persistence-jsonl',join(owned,'sessions')],['@deepseek-ai/dsh-storage-json',join(owned,'storages')],['unknown-plugin',foreign]]){
        registerManagedDataPath({owner:owner!,kind:'directory',path:path!},join(owned,'managed-data.jsonl'))
      }
      await writeFile(conf,JSON.stringify({version:1,organizationId:binding.organizationId,nodeId:binding.sourceNodeId,provider:'btrfs',
        runtimes:[{runtimeId:runtime,source,snapshotDirectory:root,workspaces:[{id:workspaceId,path:work}]}]}),{mode:0o600})
      const db=new DatabaseSync(join(stage,'personal.sqlite'))
      db.exec('CREATE TABLE records(collection TEXT,body TEXT)')
      db.prepare("INSERT INTO records VALUES('workspaces',?)").run(JSON.stringify({id:workspaceId,value:JSON.stringify({workspaceId,path:work})}))
      db.close()
      const exporter=new PeerPersonalFiles(control,users,conf,1000,undefined,async()=>{
        await cp(source,frozen,{recursive:true});await writeFile(join(owned,'sessions','same.jsonl'),'continued source work\n')
        return {root:frozen,map:path=>join(frozen,relative(source,path)),confirm:async()=>{},release:async()=>{released++;await rm(frozen,{recursive:true})}}
      })
      const saved=await exporter.capture(binding,32,stage,limits,signal)
      expect(saved?.gaps).toEqual(expect.arrayContaining(['plugin:unverified-managed-paths','files:account-documents-outside-checkpoint']))
      expect(released).toBe(1)
      await verifyPersonalFiles(binding,32,saved!.receipt,stage,limits,signal,undefined,dest)
      expect(await readFile(join(dest,runtime,'runtime','sessions','same.jsonl'),'utf8')).toBe('original committed session\n')
      expect(await readFile(join(owned,'sessions','same.jsonl'),'utf8')).toBe('continued source work\n')
      const maps=JSON.parse(await readFile(join(stage,'personal-roots.json'),'utf8')) as {roots:{key:string;role:string;source:string}[]}
      expect(maps.roots.map(x=>basename(x.source))).not.toContain(sibling)
      expect(await readFile(join(dest,runtime,'workspace',maps.roots.find(x=>x.role==='workspace')!.key,'same.txt'),'utf8')).toBe('selected-file')
      await expect(readFile(join(dest,runtime,'runtime','.env'))).rejects.toMatchObject({code:'ENOENT'})
      await expect(verifyPersonalFiles({...binding,sourceNodeId:randomUUID()},32,saved!.receipt,stage,limits,signal)).rejects.toThrow()
      await expect(verifyPersonalFiles(binding,33,saved!.receipt,stage,limits,signal)).rejects.toThrow()
      await expect(verifyPersonalFiles(binding,32,saved!.receipt,stage,limits,signal,undefined,dest)).rejects.toMatchObject({code:'EEXIST'})
      await writeFile(join(stage,'personal-files','00000000.data'),'tampered')
      await expect(verifyPersonalFiles(binding,32,saved!.receipt,stage,limits,signal)).rejects.toThrow()
      generation='3'
    }finally{await rm(root,{recursive:true,force:true})}
  })
})
