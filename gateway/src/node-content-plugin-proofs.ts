/** Operator-reviewed installed plugins, constrained configurations and pure provider-specific checks. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat,open,readdir,realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname,isAbsolute,join,relative,resolve,sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { privateDirectoryState,privateFileState,protectedDirectoryState,protectedFileState } from './node-private-file.ts'
import type { NodePluginProofInput,NodePluginProofs } from './node-content-files.ts'
import { NodeContentUnavailable,assertLocalMount } from './node-content-store.ts'

const hash=z.string().regex(/^[a-f0-9]{64}$/u)
const plugin=z.object({owner:z.string().regex(/^(?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*$/u),releaseDirectory:z.string(),releaseSha256:hash,
  configurations:z.array(hash).min(1).max(64),storage:z.array(z.enum(['runtime-storage','workspace'])).max(2),
  verifier:z.object({file:z.string(),sha256:hash}).strict().optional()}).strict()
const policies=z.object({version:z.literal(1),plugins:z.array(plugin).max(128)}).strict()
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
function deny(message:string):never{throw new NodeContentUnavailable(message)}
function within(base:string,path:string):boolean{const r=relative(base,path);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep))}
function absolute(path:string):void{if(!isAbsolute(path)||resolve(path)!==path)deny('Plugin proof paths must be canonical and absolute.')}
async function bytes(path:string,max:number,operator=false,ownerReference?:string):Promise<Buffer>{
  absolute(path)
  if(await realpath(path)!==path)deny('A reviewed plugin proof or artifact contains a symbolic link.')
  const handle=await open(path,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW))
  try {
    const info=await handle.stat()
    if(!operator&&(process.platform!=='win32'&&info.uid!==0&&info.uid!==process.getuid!()||await protectedFileState(path,info,undefined,ownerReference)!=='protected'))deny('A reviewed plugin artifact is writable by another account.')
    if(!info.isFile()||info.nlink!==1||info.size>max||(operator&&await privateFileState(path,info,max)!=='private'))deny('A plugin proof file failed the ownership or size check.')
    const value=await handle.readFile(),after=await handle.stat()
    if(value.length!==info.size||after.ino!==info.ino||after.mtimeMs!==info.mtimeMs||after.ctimeMs!==info.ctimeMs)deny('A plugin artifact changed while it was being verified.')
    return value
  } finally {await handle.close()}
}

/** Fingerprint every regular file in a release before it can be selected by an operator-owned rule.
 * @param root - canonical installed release directory. @returns SHA-256 of sorted paths and exact artifact bytes.
 */
export async function nodePluginReleaseDigest(root:string,ownerReference?:string):Promise<string>{
  absolute(root)
  if(await realpath(root)!==root || !(await lstat(root)).isDirectory())deny('The approved release is not a canonical directory.')
  const entries:Array<[string,string]>=[]
  let total=0,visited=0
  const walk=async(dir:string):Promise<void>=>{
    const info=await lstat(dir)
    if(process.platform!=='win32'&&info.uid!==0&&info.uid!==process.getuid!()||await protectedDirectoryState(dir,info,undefined,ownerReference)!=='protected')deny('A reviewed plugin directory is writable by another account.')
    const children=await readdir(dir,{withFileTypes:true})
    for(const entry of children){
      if(++visited>512)deny('The reviewed plugin release exceeds the bounded inventory.')
      const path=join(dir,entry.name)
      if(entry.isDirectory())await walk(path)
      else if(entry.isFile()){
        const value=await bytes(path,16*1024*1024-total,false,ownerReference);total+=value.length
        entries.push([relative(root,path).split(sep).join('/'),digest(value)])
      } else deny('A reviewed plugin release must contain only regular files and directories.')
    }
  }
  await walk(root)
  return digest(JSON.stringify(entries.sort((a,b)=>Buffer.compare(Buffer.from(a[0]),Buffer.from(b[0])))))
}

// A pure module receives one bounded memory, no host functions, paths, sockets, inherited environment or Node handles.
const evaluator=`const chunks=[]; for await(const part of process.stdin)chunks.push(part); const {wasm,input}=JSON.parse(Buffer.concat(chunks));
const raw=Buffer.from(wasm,'base64');let pos=8;while(pos<raw.length){const kind=raw[pos++];let length=0,shift=0;for(;;){if(pos>=raw.length||shift>28)throw Error();const n=raw[pos++];length+=(n&127)*2**shift;if(!(n&128))break;shift+=7}if(kind===4||kind===5||length>raw.length-pos)throw Error();pos+=length}
const mod=await WebAssembly.compile(raw),imports=WebAssembly.Module.imports(mod);if(imports.length!==1||imports[0].module!=='proof'||imports[0].name!=='memory'||imports[0].kind!=='memory')throw Error();
const memory=new WebAssembly.Memory({initial:2,maximum:4});const inst=await WebAssembly.instantiate(mod,{proof:{memory}});const request=Buffer.from(input,'base64');new Uint8Array(memory.buffer).set(request,0);
if(typeof inst.exports.verify!=='function'||inst.exports.verify(0,request.length)!==1)process.exitCode=1;else process.stdout.write('1');`
async function runProof(wasm:Buffer,input:Buffer,timeout:number):Promise<void>{
  if(input.length>65_536)deny('The selected plugin configuration is too large for its proof.')
  const passed=await new Promise<boolean>(done=>{
    const child=execFile(process.execPath,['--max-old-space-size=32','--input-type=module','-e',evaluator],{
      env:{},timeout,maxBuffer:256,killSignal:'SIGKILL',windowsHide:true,encoding:'utf8',
    },(error,out)=>done(!error&&out==='1'))
    child.stdin?.on('error',()=>{ /* A failed verifier can exit before receiving its input. */ })
    child.stdin?.end(JSON.stringify({wasm:wasm.toString('base64'),input:input.toString('base64')}))
  })
  if(!passed)deny('The independent plugin storage verifier refused the effective configuration.')
}

async function verifiedRoots(file:string,timeout:number,request:NodePluginProofInput):Promise<string[]>{
  const {owner,workspace,home}=request
  absolute(file)
  const directory=dirname(file)
  if(within(workspace,directory)||within(home,directory)||await realpath(directory)!==directory||
     await privateDirectoryState(directory,await lstat(directory))!=='private')deny('Plugin approval requires a private operator directory outside the project.')
  const entries=policies.parse(JSON.parse((await bytes(file,256*1024,true)).toString('utf8'))).plugins.filter(p=>p.owner===owner)
  if(entries.length!==1)deny('This installed plugin does not have a unique operator-reviewed storage rule.')
  const rule=entries[0]!,root=rule.releaseDirectory
  absolute(root)
  const installation=dirname(directory)
  if(within(workspace,root)||within(home,root)||!within(installation,root)||installation===dirname(installation))deny('The reviewed plugin release must be under the operator installation outside the project.')
  for(let path=dirname(root);within(installation,path);path=dirname(path)){
    const info=await lstat(path)
    if(process.platform!=='win32'&&info.uid!==0&&info.uid!==process.getuid!()||await protectedDirectoryState(path,info,undefined,file)!=='protected')deny('The operator installation permits release replacement by another account.')
    if(path===installation)break
  }
  await assertLocalMount(root,timeout)
  if(await nodePluginReleaseDigest(root,file)!==rule.releaseSha256)deny('The selected plugin release changed and requires verification.')
  const bootFile=createRequire(request.installAnchor).resolve('@deepseek-ai/dsh-app-boot')
  const boot=await import(pathToFileURL(bootFile).href) as typeof import('@deepseek-ai/dsh-app-boot')
  const profileDir=join(home,'profiles','web')
  const profile=boot.loadProfileDirectory('dsh',profileDir,request.installAnchor)
  const resolved=await boot.createRuntimeResolution({installAnchor:request.installAnchor,profile,home})
  const selected=resolved.localPackageNames.includes(owner)?await realpath(join(profileDir,'node_modules',...owner.split('/'))):resolved.entries.findLast(r=>r.name===owner)?.packageDir
  if(!selected||await realpath(selected)!==root)deny('The active Runtime profile resolves this plugin to a different release.')
  const config=JSON.stringify(request.configuration)
  if(config.includes('"dynamicExpression":')||!rule.configurations.includes(digest(config)))deny('This effective plugin configuration requires a current operator proof.')
  const roots=[...new Set(rule.storage.map(kind=>kind==='workspace'?workspace:join(home,'storages')))]
  if(request.paths.some(path=>!roots.some(allowed=>within(allowed,path))))deny('A plugin reported storage outside its reviewed project roots.')
  if(rule.verifier){
    if(!within(directory,rule.verifier.file)||within(workspace,rule.verifier.file)||within(home,rule.verifier.file))deny('The plugin verifier must be installed in the operator directory.')
    const module=await bytes(rule.verifier.file,64*1024,true)
    if(digest(module)!==rule.verifier.sha256)deny('The independent plugin verifier changed.')
    await runProof(module,Buffer.from(JSON.stringify({release:rule.releaseSha256,configuration:request.configuration,
      storage:rule.storage,observed:request.paths.map(p=>{const index=roots.findIndex(root=>within(root,p));return [index,relative(roots[index]!,p)]})})),timeout)
  }
  return roots
}

/** Lazy, node-local operator proofs; the Gateway never imports the user plugin to check its storage.
 * @param file - optional private reviewed rules. @param timeout - bounded provider-check deadline.
 * @returns the verifier lookup used by the active project profile.
 */
export function createNodePluginProofs(file:string|undefined,timeout:number):NodePluginProofs{
  return {get:()=>file===undefined?undefined:async input=>{
    try{return await verifiedRoots(file,timeout,input)}catch(error){if(error instanceof NodeContentUnavailable)throw error;return deny('The approved plugin release, profile or storage proof could not be verified.')}
  }}
}
