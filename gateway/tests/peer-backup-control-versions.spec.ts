import { createHash,randomUUID } from 'node:crypto'
import { mkdtemp,readFile,realpath,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect,it } from 'vitest'
import {controlCoverageGaps,names,projections,validatePeerControl} from '../src/peer-backup-control-validation.ts'

it('keeps private version-one inventories readable and refuses a complete-governance claim or new unapproved fields',async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'personal-legacy-control-'))),org=randomUUID(),node=randomUUID()
  const binding={organizationId:org,sourceNodeId:node,scopeId:org,targetNodeId:randomUUID(),policyId:randomUUID(),revision:1}
  const limits={maxRows:10,maxBytes:10000},signal=AbortSignal.timeout(5000)
  const row=(fields:string)=>Object.fromEntries(fields.split(',').map(key=>[key.replace('id AS ',''),null]))
  const records=[{table:'organizations',row:{...row(projections.organizations),organization_id:org}},
    {table:'deployment_topology',row:{...row(projections.deployment_topology),organization_id:org,enabled:true,primary_node_id:node,revision:1}},
    {table:'projects',row:{...row(projections.projects),organization_id:org,name:'historical-project'}}]
  try {
    const payload=records.map(v=>JSON.stringify(v)+'\n').join('')
    await writeFile(join(directory,'governance.jsonl'),payload)
    const manifest={version:1,rows:records.length,sha256:createHash('sha256').update(payload).digest('hex'),topologyRevision:'1',watermark:'100'}
    await writeFile(join(directory,'governance.json'),JSON.stringify(manifest))
    const capture={version:1 as const,organizationId:org,sourceNodeId:node,scopeId:org,writerEpoch:'1',watermark:'100',capturedAt:new Date().toISOString(),
      coveredCount:17,gaps:[...controlCoverageGaps]}
    await validatePeerControl(binding,capture,directory,signal,limits)
    expect(await readFile(join(directory,'governance.jsonl'),'utf8')).toBe(payload)
    await expect(validatePeerControl(binding,{...capture,gaps:[]},directory,signal,limits)).rejects.toThrow()
    await expect(validatePeerControl(binding,{...capture,coveredCount:names.length},directory,signal,limits)).rejects.toThrow()
    await writeFile(join(directory,'governance.json'),JSON.stringify({...manifest,version:2}))
    await expect(validatePeerControl(binding,{...capture,coveredCount:names.length},directory,signal,limits)).rejects.toThrow()
  }finally{await rm(directory,{recursive:true,force:true})}
})

it.each([{version:2,coveredCount:19},{version:3,coveredCount:22},{version:4,coveredCount:26},{version:5,coveredCount:28},{version:6,coveredCount:names.length},{version:7,coveredCount:names.length}])(
  'validates inventory version $version with its fixed metadata fields',async({version,coveredCount})=>{
    const directory=await realpath(await mkdtemp(join(tmpdir(),'peer-control-version-'))),org=randomUUID(),node=randomUUID()
    const binding={organizationId:org,sourceNodeId:node,scopeId:org,targetNodeId:randomUUID(),policyId:randomUUID(),revision:1}
    const fields=(columns:string)=>Object.fromEntries(columns.split(',').filter(key=>version>=7||key!=='repository_node_id').map(key=>[key.replace('id AS ',''),null]))
    const records:Array<{table:string;row:Record<string,unknown>}>= [{table:'organizations',row:{...fields(projections.organizations),organization_id:org}},
      {table:'deployment_topology',row:{...fields(projections.deployment_topology),organization_id:org,enabled:true,primary_node_id:node,revision:1}}]
    const limits={maxRows:10,maxBytes:10000},signal=AbortSignal.timeout(5000)
    const capture={version:1 as const,organizationId:org,sourceNodeId:node,scopeId:org,writerEpoch:'1',watermark:'100',
      capturedAt:new Date().toISOString(),coveredCount,gaps:[...controlCoverageGaps]}
    const save=async()=>{
      const payload=records.map(row=>JSON.stringify(row)+'\n').join('')
      await writeFile(join(directory,'governance.jsonl'),payload)
      await writeFile(join(directory,'governance.json'),JSON.stringify({version,rows:records.length,
        sha256:createHash('sha256').update(payload).digest('hex'),topologyRevision:'1',watermark:'100'}))
    }
    try {
      await save()
      await validatePeerControl(binding,capture,directory,signal,limits)
      Object.assign(records[0]!,{privateContent:'node-only contents'})
      await save()
      await expect(validatePeerControl(binding,capture,directory,signal,limits)).rejects.toMatchObject({code:'peer-backup/invalid-export'})
      delete (records[0] as {privateContent?:string}).privateContent
      records.push({table:'project_recovery_execution_reviews',row:{...fields(projections.project_recovery_execution_reviews),organization_id:org}})
      await save()
      if(version<4) await expect(validatePeerControl(binding,capture,directory,signal,limits)).rejects.toMatchObject({code:'peer-backup/cross-scope-row'})
      else {
        await validatePeerControl(binding,capture,directory,signal,limits)
        records[2]!.row={...records[2]!.row,oldSessionIds:['private-session']}
        await save()
        await expect(validatePeerControl(binding,capture,directory,signal,limits)).rejects.toMatchObject({code:'peer-backup/invalid-export'})
      }
      for(const table of ['project_recovery_execution_transfers','recovery_source_isolations'] as const){
        records[2]={table,row:{...fields(projections[table]),organization_id:org}}
        await save()
        if(version<5) await expect(validatePeerControl(binding,capture,directory,signal,limits)).rejects.toMatchObject({code:'peer-backup/cross-scope-row'})
        else {
          await validatePeerControl(binding,capture,directory,signal,limits)
          records[2]!.row={...records[2]!.row,policyFile:'/private/node/policy.json'}
          await save()
          await expect(validatePeerControl(binding,capture,directory,signal,limits)).rejects.toMatchObject({code:'peer-backup/invalid-export'})
        }
      }
      for(const [table,privateColumn] of [['node_user_accounts','home_path'],['instances','runtime_token_hash'],['audit_events','detail'],
        ['personal_recovery_operations','workspace'],['personal_recovery_execution_reviews','oldSessionIds']] as const){
        records[2]={table,row:{...fields(projections[table]),organization_id:org}}
        await save()
        if(version<6) await expect(validatePeerControl(binding,capture,directory,signal,limits)).rejects.toMatchObject({code:'peer-backup/cross-scope-row'})
        else {
          await validatePeerControl(binding,capture,directory,signal,limits)
          records[2]!.row={...records[2]!.row,[privateColumn]:'private-node-data'}
          await save()
          await expect(validatePeerControl(binding,capture,directory,signal,limits)).rejects.toMatchObject({code:'peer-backup/invalid-export'})
        }
      }
    } finally {await rm(directory,{recursive:true,force:true})}
  })
