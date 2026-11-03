/** Built Linux filesystem ownership check under a distinct, non-root execution account. */
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {promisify} from 'node:util'
import {prepareProjectRuntimeData} from '../../lib/project-runtime-data.js'
import {writeProjectModelGovernanceFile} from '../../lib/apply-model-governance.js'
assert.equal(process.platform,'linux');assert.equal(process.getuid(),0,'This acceptance requires two real Unix identities')
const execute=promisify(execFile),root=mkdtempSync(join(tmpdir(),'hgw-project-policy-owner-'))
try{
 chmodSync(root,0o755)
 const home=join(root,'27','dsh');mkdirSync(home,{recursive:true,mode:0o700})
 const patch=join(home,'cordis.patch.yml'),policyFile=join(home,'model-governance.json')
 writeFileSync(patch,'[]\n',{mode:0o600})
 const policy={version:1,defaultAllowed:false,models:[{provider:'fixture',model:'m',allowed:true}],providers:[]}
 const governance={policyForProject:()=>policy,issueIntakeToken:()=> 'fixture-private-token',subjectForIntakeToken:()=>({kind:'project',id:27})}
 const cfg={projectRuntimesRoot:root,readinessTimeoutMs:10000,intakePort:1}
 await writeProjectModelGovernanceFile(cfg,governance,{id:27})
 const bytes=readFileSync(policyFile)
 await prepareProjectRuntimeData(cfg,27,'nobody','web',new AbortController().signal)
 const uid=Number((await execute('id',['-u','nobody'])).stdout.trim())
 for(let i=0;i<2;i++){
  if(i===1)policy.models[0].allowed=false
  await writeProjectModelGovernanceFile(cfg,governance,{id:27})
  for(const path of [patch,policyFile]){
   assert.equal(statSync(path).uid,uid);assert.equal(statSync(path).mode&0o777,0o600)
   await execute('runuser',['-u','nobody','--',process.execPath,'-e','require("node:fs").readFileSync(process.argv[1])',path])
  }
  if(i===0)assert.deepEqual(readFileSync(policyFile),bytes,'Ownership repair must preserve a current credential and policy byte for byte')
 }
 console.log('Private project policy retains its execution owner through current-policy reuse and atomic default updates.')
 console.log('The non-root execution account reads both files; private permissions remain 0600.')
}finally{rmSync(root,{recursive:true,force:true})}
