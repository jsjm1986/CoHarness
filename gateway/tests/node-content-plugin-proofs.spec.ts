/** Load the same installed profile module as a Runtime, then verify reviewed storage without executing plugin code in the Gateway. */
import { createHash,randomUUID } from 'node:crypto'
import { chmod,mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { expect,it } from 'vitest'
import { runGatewayChildCommand } from '../src/child-command.ts'
import { createNodePluginProofs,nodePluginReleaseDigest } from '../src/node-content-plugin-proofs.ts'
import type { NodePluginProofInput } from '../src/node-content-files.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'
const sha=(s:Buffer|string)=>createHash('sha256').update(s).digest('hex')

it('accepts the selected audited extension and rejects changed bytes, configuration, storage, verifier and symbolic proofs',async()=>{
  const directory=await mkdtemp(join(await realpath(tmpdir()),'hgw-plugin-review-'))
  try {
    const home=join(directory,'runtime'),workspace=join(directory,'workspace'),operator=join(directory,'operator')
    const release=join(operator,'extension'),profile=join(home,'profiles','web'),name='reviewed-project-fixture'
    const policy=join(operator,'proofs.json'),verifier=join(operator,'independent.wasm')
    await Promise.all([mkdir(release,{recursive:true,mode:0o700}),mkdir(join(profile,'node_modules'),{recursive:true,mode:0o700}),mkdir(workspace,{mode:0o700})])
    const entry=join(release,'index.mjs')
    await writeFile(join(release,'package.json'),JSON.stringify({name,version:'1.0.0',type:'module',exports:'./index.mjs'}))
    const program="import {writeFile} from 'node:fs/promises'; import {join} from 'node:path'; export async function apply(ctx){await writeFile(join(ctx.workspace,'extension-output.txt'),'local result')}"
    await writeFile(entry,program)
    await symlink(release,join(profile,'node_modules',name),'junction')
    await writeFile(join(profile,'package.json'),JSON.stringify({name:'review-profile',private:true,type:'module',dependencies:{[name]:'file:'+release},dsh:{profile:{bundles:[]}}}))
    const input:NodePluginProofInput={binding:{organizationId:randomUUID(),nodeId:randomUUID(),projectId:randomUUID(),runtimeId:randomUUID() as RuntimeId,volumeId:randomUUID(),writerEpoch:'1'},
      owner:name,home,workspace,installAnchor:resolve(import.meta.dirname,'../../apps/cli/package.json'),configuration:[],paths:[workspace]}
    // (module (import "proof" "memory" (memory 1 4)) (func (export "verify") (param i32 i32) (result i32) local.get 1 i32.const 0 i32.gt_u))
    const wasm=Buffer.from('0061736d0100000001070160027f7f017f0212010570726f6f66066d656d6f72790201010403020100070a010676657269667900000a09010700200141004b0b','hex')
    await writeFile(verifier,wasm,{mode:0o600})
    const rule={owner:name,releaseDirectory:release,releaseSha256:await nodePluginReleaseDigest(release),configurations:[sha('[]')],storage:['workspace'],verifier:{file:verifier,sha256:sha(wasm)}}
    const save=(v:typeof rule)=>writeFile(policy,JSON.stringify({version:1,plugins:[v]}),{mode:0o600})
    await save(rule)
    const check=createNodePluginProofs(policy,3000).get(name)!
    expect(await check(input)).toEqual([workspace])
    const probe=join(profile,'launch.mjs')
    await writeFile(probe,`import {apply} from ${JSON.stringify(name)}; await apply({workspace:process.argv[2]})`)
    await runGatewayChildCommand(process.execPath,[probe,workspace],3000)
    expect(await readFile(join(workspace,'extension-output.txt'),'utf8')).toBe('local result')
    await expect(check({...input,configuration:[{root:'https://unexpected.test'}]})).rejects.toThrow('current operator proof')
    await expect(check({...input,paths:[directory]})).rejects.toThrow('outside its reviewed project roots')
    await writeFile(entry,program+'\n')
    await expect(check(input)).rejects.toThrow('release changed')
    await writeFile(entry,program)
    await writeFile(verifier,Buffer.from([0]))
    await expect(check(input)).rejects.toThrow('verifier changed')
    await writeFile(verifier,wasm)
    if(process.platform!=='win32'){
      await chmod(policy,0o644)
      await expect(check(input)).rejects.toThrow('ownership or size')
      await chmod(policy,0o600)
      const redirected=join(operator,'redirected.json');await symlink(policy,redirected)
      await expect(createNodePluginProofs(redirected,1000).get(name)!(input)).rejects.toThrow('symbolic link')
    }
  } finally { await rm(directory,{recursive:true,force:true}) }
})
