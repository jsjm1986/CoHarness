/** Compiled real-Gateway audit pages with a caller-supplied Playwright runtime and browser. */
import assert from 'node:assert/strict'
import {fork} from 'node:child_process'
import {readFile,mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {postgresTestDatabaseUrl} from './postgres-test-database.mjs'

const [artifactInput,adminInput,browserModule,executable,record]=process.argv.slice(2)
assert.ok(artifactInput && adminInput && browserModule && executable,
 'Provide Gateway lib directory, Admin build directory, Playwright module file and browser executable')
assert.ok(record===undefined || record==='--record')
const artifactRoot=resolve(artifactInput),adminRoot=resolve(adminInput)
const databaseUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL);assert.ok(databaseUrl)
const {chromium}=await import(pathToFileURL(browserModule).href)
const snapshots=new URL('./expected/projects/audit-page-browser.jsonl',import.meta.url)
const screenshots=process.env.DSH_AUDIT_BROWSER_SCREENSHOTS
if(screenshots!==undefined)await mkdir(screenshots,{recursive:true})
const browser=await chromium.launch({headless:true,executablePath:executable})
const observations=[]
async function deadline(promise,message){
 let timer
 try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),30000);timer.unref()})])}
 finally {clearTimeout(timer)}
}
try {
 for(const backend of ['sqlite','postgres']) for(const width of [1280,390,320]) {
  const root=await mkdtemp(join(tmpdir(),'audit-browser-driver-'))
  const env={...process.env,HGW_TEST_DATABASE_URL:databaseUrl,DSH_HOME:join(root,'.dsh'),DSH_AGENTS_HOME:join(root,'.agents'),DSH_AUDIT_BROWSER_ROOT:adminRoot}
  for(const key of ['NODE_OPTIONS','NODE_PATH','TSX_TSCONFIG_PATH','DSH_MANAGED_DATA_MANIFEST']) delete env[key]
  const child=fork(fileURLToPath(new URL('./fixtures/audit-query.mjs',import.meta.url)),['lib',backend,artifactRoot],{cwd:root,env,execArgv:[],silent:true})
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk})
  let spawnError
  child.once('error',error=>{spawnError=error})
  const exited=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})))
  const messages=[];const listeners=[]
  child.on('message',message=>{messages.push(message);for(const listener of [...listeners]) listener()})
  function receive(kind){
   const received=new Promise((resolve,reject)=>{
    const inspect=()=>{const message=messages.find(message=>message.kind===kind);if(message!==undefined){listeners.splice(listeners.indexOf(inspect),1);resolve(message)}}
    listeners.push(inspect);inspect()
    exited.then(result=>reject(new Error('Gateway exited before '+kind+': '+JSON.stringify(result)+' '+stderr+' '+(spawnError?.message??''))))
   })
   return deadline(received,'Gateway IPC deadline: '+kind)
  }
  let context,primaryError
  try {
   const ready=await receive('ready')
   context=await browser.newContext({viewport:{width,height:900},locale:'zh-CN'})
   const equal=ready.cookie.indexOf('=')
   await context.addCookies([{name:ready.cookie.slice(0,equal),value:ready.cookie.slice(equal+1),url:ready.origin},{name:'hgw_lang',value:'zh',url:ready.origin}])
   const page=await context.newPage()
   const errors=[];page.on('pageerror',error=>errors.push(error.message))
   await page.goto(ready.origin+'/admin/audit',{waitUntil:'domcontentloaded'})
   await receive('older-entered')
   const selected=page.getByRole('button',{name:'认证',exact:true})
   const response=page.waitForResponse(response=>response.url().includes('/admin/api/audit?')&&new URL(response.url()).searchParams.get('family')==='auth')
   await selected.click();assert.equal((await response).status(),200)
   await page.locator('.auditAction').first().waitFor({state:'attached'})
   assert.equal(await selected.getAttribute('aria-pressed'),'true')
   const actions=await page.locator('.auditAction strong').allTextContents()
   assert.ok(actions.length>0 && actions.every(action=>action==='login'),JSON.stringify(actions))
   const olderResponse=page.waitForResponse(response=>response.url().includes('/admin/api/audit?')&&!new URL(response.url()).searchParams.has('family'))
   child.send('release-older');await(await olderResponse).finished()
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
   const currentActions=await page.locator('.auditAction strong').allTextContents()
   assert.deepEqual(currentActions,actions)
   assert.equal(await selected.getAttribute('aria-pressed'),'true')
   assert.equal(await page.getByRole('alert').count(),0)
   assert.deepEqual(errors,[])
   const geometry=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth}))
   assert.ok(geometry.scrollWidth<=geometry.viewport,JSON.stringify({backend,width,...geometry}))
   if(screenshots!==undefined)await page.screenshot({path:join(screenshots,'audit-query-'+backend+'-'+width+'.png'),fullPage:true})
   await selected.press('Tab')
   assert.ok(await page.getByRole('button',{name:'模型拒绝',exact:true}).evaluate(node=>node===document.activeElement))
   const lastFamily=page.getByRole('button',{name:'失败请求',exact:true})
   const bounds=await lastFamily.boundingBox();assert.ok(bounds!==null && bounds.x>=0 && bounds.x+bounds.width<=width)
   const lastResponse=page.waitForResponse(response=>response.url().includes('/admin/api/audit?')&&new URL(response.url()).searchParams.get('family')==='api')
   await lastFamily.click();assert.equal((await lastResponse).status(),200)
   await page.getByText('没有匹配的记录',{exact:true}).waitFor({state:'visible'})
   observations.push({backend,width,retainedFamily:'auth',olderRealRequestReleased:true,currentActions,
    pageErrors:errors,documentFitsViewport:true,lastFamilyReachable:true,keyboardFocusPreserved:true})
  } catch(error) {
   primaryError=error
   throw error
  } finally {
   const failures=[]
   const close=async work=>{try{await work()}catch(error){failures.push(error)}}
   await close(async()=>{await context?.close()})
   await close(async()=>{if(child.connected)await new Promise((done,fail)=>child.send('close',error=>error?fail(error):done()))})
   await close(async()=>{
    let result
    try {result=await deadline(exited,'Gateway cleanup deadline')}
    catch(error){child.kill('SIGKILL');await exited;throw error}
    assert.equal(result.signal,null);assert.equal(result.code,0,stderr)
   })
   await close(async()=>{await rm(root,{recursive:true,force:true})})
   if(failures.length>0)throw new AggregateError(primaryError===undefined?failures:[primaryError,...failures],'Audit browser cleanup failed')
  }
 }
} finally {await browser.close()}
const transcript=observations.map(row=>JSON.stringify(row)).join('\n')+'\n'
if(record==='--record')await writeFile(snapshots,transcript)
else assert.equal(transcript,await readFile(snapshots,'utf8'))
process.stdout.write(transcript)
