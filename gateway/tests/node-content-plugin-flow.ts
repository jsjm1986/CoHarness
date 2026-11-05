/** Live Gateway plugin configuration and local filesystem placement for a physically selected test project. */
import {mkdir,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {expect} from 'vitest'
import type {PostgresRuntimeContext} from '../src/postgres/runtime-context.ts'
import {transaction} from '../src/postgres/database.ts'
import {NodeProjectFiles} from '../src/node-content-files.ts'
import {NodeContentUnavailable,type NodeContentBinding,type NodeContentStore} from '../src/node-content-store.ts'
import {PostgresPluginState} from '../src/plugin-state.ts'
import {testConfig} from './test-config.ts'

/** Verify local Admin read/write, Runtime publication and startup projection without starting an OS Runtime. */
export async function verifyNodePluginStorage(context:PostgresRuntimeContext,store:NodeContentStore,b:NodeContentBinding,actor:number,
  workspace:string,directory:string):Promise<void>{
  const cfg=testConfig(join(directory,'file-witness'))
  const files=new NodeProjectFiles(cfg,context,store)
  const plugins=new PostgresPluginState(context,store,files)
  const id=Number((await context.pool.query('SELECT public_id FROM harness.projects WHERE id=$1',[b.projectId])).rows[0].public_id)
  const target={kind:'project' as const,id,runtimeId:b.runtimeId}
  const home=join(cfg.projectRuntimesRoot,String(id),'dsh')
  await mkdir(join(home,'storages'),{recursive:true})
  const policy=await readFile(join(cfg.dshRepoRoot,'plugins','dsh-model-governance','cordis.patch.yml'),'utf8')
  const guard=await readFile(join(cfg.dshRepoRoot,'plugins','dsh-directory-guard','cordis.patch.yml'),'utf8')
  await writeFile(join(home,'cordis.patch.yml'),policy+'\n'+guard)
  await writeFile(join(home,'managed-data.jsonl'),JSON.stringify({version:1,owner:'@deepseek-ai/dsh-storage-json',kind:'directory',path:await realpath(join(home,'storages'))})+'\n')
  await transaction(context.pool,control=>store.write(b,async local=>{
    const input={control,local,binding:b}
    await plugins.verifyNodeContent(input)
    await files.publication(input,'memory')
  }))
  await mkdir(join(cfg.projectRuntimesRoot,String(id),'dsh','storages'),{recursive:true})
  await files.verify(b)
  await rename(workspace,workspace+'-original')
  try {
    await mkdir(workspace)
    await expect(files.verify(b)).rejects.toBeInstanceOf(NodeContentUnavailable)
  }finally{
    await rm(workspace,{recursive:true,force:true})
    await rename(workspace+'-original',workspace)
  }
  const desired={entries:[{id:'memory',disabled:true}],bundles:[]}
  const created=await plugins.set(target,desired,'0',actor)
  expect(created.state).toEqual(desired)
  expect(await plugins.get(target)).toEqual(created)
  expect(await plugins.projection(target)).toEqual(created)
  await plugins.markApplied(target,created.revision)
  expect(await plugins.projection(target)).toBe('current')
  await expect(plugins.set(target,{entries:[{id:'unknown-custom',name:'unregistered-test-plugin',disabled:false}],bundles:[]},created.revision,actor)).rejects.toBeInstanceOf(NodeContentUnavailable)
  await expect(plugins.set(target,desired,'0',actor)).rejects.toMatchObject({status:409})
  expect((await plugins.list()).find(row=>row.target.runtimeId===b.runtimeId)).toMatchObject({entries:1,disabled:1,bundles:0})
  await context.pool.query('UPDATE harness.instances SET generation=2 WHERE runtime_id=$1',[b.runtimeId])
  const subject={organizationId:b.organizationId,projectInternalId:b.projectId,generation:2,target}
  const post=await plugins.publishForSubject(subject,{entries:[{id:'memory',disabled:false}],bundles:[]},created.revision)
  expect(post.status).toBe('applied')
  expect(await plugins.projection(target)).toBe('current')
  const applied=await plugins.applied(target)
  expect(await plugins.set(target,null,applied,actor)).toEqual({revision:'0',state:null})
  const again=await plugins.set(target,desired,'0',actor)
  expect(BigInt(again.revision)).toBeGreaterThan(BigInt(applied))
  expect((await context.pool.query('SELECT FROM harness.plugin_states WHERE organization_id=$1 AND runtime_id=$2',[b.organizationId,b.runtimeId])).rowCount).toBe(0)
}
