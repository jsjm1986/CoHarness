/** Native profile protection includes actual installed bytes and never follows an unproved module link. */
import { mkdtemp,mkdir,writeFile,readFile,symlink,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect,it } from 'vitest'
import { nativeRuntimeProfileData,suspendRecoveredEnvironment } from '../src/peer-runtime-profile.ts'

it('archives regular installed artifacts and marks a linked module incomplete without reading outside the Runtime',async()=>{
  const root=await mkdtemp(join(tmpdir(),'native-profile-')),home=join(root,'home'),profile=join(home,'profiles','web'),pkg=join(profile,'node_modules','private-plugin')
  try{
    await mkdir(pkg,{recursive:true,mode:0o700});await writeFile(join(pkg,'index.js'),'export default 1\n');await writeFile(join(home,'cordis.patch.yml'),'[]\n')
    await writeFile(join(home,'.recovery-environment.json'),'{"version":1,"keys":["PGHOST"]}\n')
    const actual=await nativeRuntimeProfileData(home,path=>path,100,AbortSignal.timeout(5000))
    expect(actual.gaps).toEqual([])
    expect(actual.roots).toContainEqual({owner:'gateway-runtime-profiles',kind:'directory',path:join(home,'profiles')})
    expect(actual.roots).toContainEqual({owner:'gateway-runtime-configuration',kind:'file',path:join(home,'.recovery-environment.json')})
    const external=join(root,'external');await mkdir(external);await writeFile(join(external,'private.txt'),'must remain outside')
    await symlink(external,join(profile,'node_modules','foreign'),process.platform==='win32'?'junction':'dir')
    const linked=await nativeRuntimeProfileData(home,path=>path,100,AbortSignal.timeout(5000))
    expect(linked.gaps).toContain('files:linked-runtime-profile-artifacts')
    expect(linked.roots.some(row=>row.path===join(home,'profiles')||row.path===external)).toBe(false)
  }finally{await rm(root,{recursive:true,force:true})}
})

it('suspends old control and libpq connection settings while preserving unrelated PGP and multiline business values',async()=>{
  const root=await mkdtemp(join(tmpdir(),'recovery-env-'))
  try{
    await writeFile(join(root,'.env'),'HGW_NODE_TOKEN=old\nDSH_GATEWAY_CREDENTIAL_FD=5\nPGHOST=old-db\nDATABASE_URL=old-url\nPGP_RECIPIENT=keep\nBUSINESS_TEXT="line one\nline two"\n')
    expect(await suspendRecoveredEnvironment(root,65536)).toEqual(['DATABASE_URL','DSH_GATEWAY_CREDENTIAL_FD','HGW_NODE_TOKEN','PGHOST'])
    const text=await readFile(join(root,'.env'),'utf8')
    expect(text).not.toContain('old');expect(text).toContain('PGP_RECIPIENT="keep"');expect(text).toContain('line one\nline two')
    expect(await suspendRecoveredEnvironment(root,65536)).toEqual([])
  }finally{await rm(root,{recursive:true,force:true})}
})
