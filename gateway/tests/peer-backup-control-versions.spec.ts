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
      coveredCount:names.length-2,gaps:[...controlCoverageGaps]}
    await validatePeerControl(binding,capture,directory,signal,limits)
    expect(await readFile(join(directory,'governance.jsonl'),'utf8')).toBe(payload)
    await expect(validatePeerControl(binding,{...capture,gaps:[]},directory,signal,limits)).rejects.toThrow()
    await expect(validatePeerControl(binding,{...capture,coveredCount:names.length},directory,signal,limits)).rejects.toThrow()
    await writeFile(join(directory,'governance.json'),JSON.stringify({...manifest,version:2}))
    await expect(validatePeerControl(binding,{...capture,coveredCount:names.length},directory,signal,limits)).rejects.toThrow()
  }finally{await rm(directory,{recursive:true,force:true})}
})
