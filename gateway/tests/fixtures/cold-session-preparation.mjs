/** Prepared Session client, real Gateway forwarding and shipped Web profile across a held cold start. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PreparedSessionApi } from '../../../packages/client/runtime/lib/types/client/prepare-runtime.js'
import { AbstractApiClient } from '../../../packages/host/apiproxy/lib/types/fetch/client.js'

/** Verify exact-target continuation through the real outbound node channel. */
export async function verifyColdSessionPreparation({pool,org,base,cookie,runtimeId,nodeId,userId,command}) {
  console.log(JSON.stringify({scope:'cold-preparation-real-dual-gateway',phase:'begin'}))
  const target={kind:'personal',runtimeId,nodeId}, timeoutMs=3000, requests=[]
  let releaseSent=false
  const release=async()=>{if(!releaseSent){releaseSent=true;await command('release-start',{runtimeId})}}
  class GatewayPrepared extends PreparedSessionApi {
    constructor(){super({metadataTiming:{requestTimeoutMs:timeoutMs,retryAfterMs:1000},interactions:'none'},target,userId)}
    resolveBase(){return base}
    async doFetch(input,init){
      const headers=new Headers(init.headers);headers.set('cookie',cookie);headers.set('origin',base)
      requests.push({path:input.pathname,runtime:input.searchParams.get('dshRuntime'),node:input.searchParams.get('dshNode'),
        target:input.searchParams.get('dshTarget'),operation:headers.get('x-dsh-operation-id'),
        continuation:headers.get('x-dsh-prepare-continuation'),body:init.body})
      try{return await super.doFetch(input,{...init,headers})}
      finally{if(requests.length===3)await release()}
    }
  }
  // The single-attempt carrier follows the former preparation behavior: no retries after a 503.
  class SingleAttempt extends AbstractApiClient {
    constructor(){super(timeoutMs,undefined,target,'none')}
    resolveBase(){return base}
    resolveUrl(path){const url=super.resolveUrl(path);url.pathname='/api/prepare/v1/session.create';url.searchParams.set('dshNode',nodeId);return url}
    async doFetch(input,init){const headers=new Headers(init.headers);headers.set('cookie',cookie);headers.set('origin',base);return fetch(input,{...init,headers})}
  }
  await command('hold-start',{runtimeId})
  const transcript=[]
  try{
    const draftId='draft-'+randomUUID(),sessionId='cold-'+randomUUID()
    await assert.rejects(new SingleAttempt().sessions.create({sessionId,draftId}),error=>error.status===503)
    transcript.push('A single-attempt client refuses pending startup; it creates no conversation.')
    const client=new GatewayPrepared(),start=performance.now()
    const result=await client.sessions.create({sessionId,draftId,defaultWorkspace:true,includeWorkspace:true,includeInitialHistory:true})
    assert.equal(result.result.ok,true,JSON.stringify(result.result));assert.equal(result.result.value.sessionId,sessionId)
    assert.ok(result.result.value.workspace?.workspaceId);assert.ok(Array.isArray(result.result.value.initialHistory?.events))
    assert.ok(performance.now()-start>timeoutMs);assert.ok(requests.length>=4)
    assert.equal(requests[0].continuation,null)
    const receipt=requests[1].continuation;assert.match(receipt,/^[\da-f-]{36}$/)
    for(const request of requests){assert.equal(request.runtime,runtimeId);assert.equal(request.node,nodeId);assert.equal(request.target,'personal');assert.equal(request.operation,draftId.slice(6));assert.equal(request.body,requests[0].body)}
    for(const request of requests.slice(1))assert.equal(request.continuation,receipt)
    transcript.push('Cold preparation crosses the outbound channel beyond one request deadline and retains one accepted start, operation and exact target.')
    transcript.push('The owning Web profile creates the requested Session in its default Workspace and returns authorized history.')
    const beforeWarm=requests.length
    const warm=await client.sessions.create({sessionId:'warm-'+randomUUID(),draftId:'draft-'+randomUUID(),defaultWorkspace:true,includeWorkspace:true})
    assert.equal(warm.result.ok,true);assert.notEqual(warm.result.value.sessionId,sessionId)
    assert.equal(requests.at(-1).continuation,null)
    assert.equal(requests.length,beforeWarm+1)
    transcript.push('A second independent creation remains a different Session and uses one hot request.')
    const generation=async()=>Number((await pool.query('SELECT generation FROM harness.instances WHERE organization_id=$1 AND runtime_id=$2',[org,runtimeId])).rows[0].generation)
    const original=await generation()
    const control=async action=>{
      const response=await fetch(`${base}/admin/api/runtimes/${runtimeId}/${action}?dshNode=${nodeId}`,{method:'POST',
        headers:{cookie,origin:base,'content-type':'application/json'},body:JSON.stringify({generation:original})})
      const body=await response.text();assert.equal(response.status,200,body)
    }
    const stale=async()=>{
      const url=new URL('/api/prepare/v1/session.create',base);url.searchParams.set('dshRuntime',runtimeId);url.searchParams.set('dshNode',nodeId);url.searchParams.set('dshTarget','personal')
      const response=await fetch(url,{method:'POST',headers:{cookie,origin:base,'content-type':'application/json','x-dsh-prepare-continuation':receipt},body:requests[0].body})
      const body=await response.text();assert.equal(response.status,503,body);assert.match(body,/INSTANCE_UNAVAILABLE/)
    }
    await control('stop');await stale();assert.equal(await generation(),original)
    await control('restart');const replacement=await generation();assert.ok(replacement>original)
    await stale();assert.equal(await generation(),replacement)
    transcript.push('Stopped and replaced generations reject the old continuation without another start or Session mutation.')
    const text=transcript.join('\n')+'\n'
    assert.equal(text,await readFile(new URL('../expected/cold-session-preparation.txt',import.meta.url),'utf8'))
    console.log(JSON.stringify({scope:'cold-preparation-real-dual-gateway',requests:beforeWarm,singleRequestTimeoutMs:timeoutMs,elapsedMs:Math.round(performance.now()-start),continued:true,workspaceVerified:true,replacedGenerationRefused:true}))
  }finally{await release()}
}
