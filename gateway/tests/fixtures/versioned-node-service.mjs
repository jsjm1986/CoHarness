/** Real prepared conversations and durable admission through a primary Gateway and an outbound node. */
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'

const routes={create:['prepare/v1/session.create','session.create'],open:['prepare/v1/session.history','session.history'],
  send:['admit/v1/session.prompt','session.prompt'],status:['admit/v1/session.status','session.promptStatus']}
const p50=values=>values.toSorted((a,b)=>a-b)[Math.ceil(values.length*.5)-1]
const p95=values=>values.toSorted((a,b)=>a-b)[Math.ceil(values.length*.95)-1]
const elapsed=(t)=>Number((performance.now()-t).toFixed(2))
async function call(base,cookie,runtime,op,payload,operationId=randomUUID(),signal){
  const [route,method]=routes[op]??[op,op],url=new URL('/api/'+route,base);url.searchParams.set('dshRuntime',runtime);url.searchParams.set('dshTarget','personal')
  const response=await fetch(url,{method:'POST',signal,headers:{cookie,origin:base,'content-type':'application/json','x-dsh-operation-id':operationId},
    body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload})})
  const body=await response.text()
  assert.equal(response.status,200,`${op} HTTP ${response.status}: ${body.slice(0,240)}`)
  const result=JSON.parse(body).result
  assert.equal(result?.ok,true,`${op} application error: ${String(JSON.stringify(result?.error)).slice(0,400)}`)
  if(routes[op]){
    assert.equal(response.headers.get('x-dsh-runtime-id'),runtime)
    assert.equal(response.headers.get('x-dsh-operation-id'),operationId)
  }
  return result.value
}
async function samples(base,cookie,id){
  const res=await fetch(base+'/admin/api/performance/operations?id='+id,{headers:{cookie}});assert.equal(res.status,200);return (await res.json()).operations
}

/** @param input Fixture-only accounts, two running Gateway addresses and their disposable organization database. */
export async function verifyVersionedNodeService({pool,org,base,secondary,local,remote,count,observeOwnerPressure}){
  assert.ok(Number.isSafeInteger(count)&&count>=1&&count<=50)
  const rpc=(who,op,input,id,signal)=>call(base,who.cookie,who.id,op,input,id,signal)
  const startup=[]
  for(const who of [local,remote]){
    const start=performance.now()
    const sel=await fetch(base+'/account/api/scope?dshRuntime='+who.id,{method:'POST',headers:{cookie:who.cookie,origin:base,'content-type':'application/json'},body:JSON.stringify({kind:'personal'})})
    assert.equal(sel.status,204,await sel.text())
    const description=await rpc(who,'host.describe',{})
    assert.equal(description.runtimeTarget.runtimeId,who.id)
    startup.push(elapsed(start))
  }
  const leases=(await pool.query(`SELECT i.runtime_id,i.assigned_node_id,i.generation,i.observed_state,(i.node_connection_id IS NOT NULL) managed,
    EXISTS(SELECT 1 FROM harness.node_agents a WHERE a.organization_id=i.organization_id AND a.node_id=i.assigned_node_id
      AND a.connection_id=i.node_connection_id AND a.execution_ready AND a.lease_expires_at>clock_timestamp()) live_lease
    FROM harness.instances i WHERE i.organization_id=$1 AND i.runtime_id=ANY($2::uuid[])`,[org,[local.id,remote.id]])).rows
  assert.equal(leases.length,2)
  for(const who of [local,remote]){const row=leases.find(r=>r.runtime_id===who.id);assert.equal(row?.assigned_node_id,who.node);assert.ok(Number(row.generation)>0);assert.equal(row.live_lease,who===remote)}
  const metrics={create:[],open:[],send:[],status:[]},sampleIds=[],primarySql=[],owner=[]
  let remoteSession,remoteRequest
  async function triplet(who,measure,iteration){
    const sessionId='session-'+randomUUID(),draftId='draft-'+randomUUID(),requestId=randomUUID(),ids={create:randomUUID(),open:randomUUID(),send:randomUUID(),status:randomUUID()}
    const created={sessionId,draftId,defaultWorkspace:true,includeWorkspace:true,includeInitialHistory:true}
    let t=performance.now();const result=await rpc(who,'create',created,ids.create);if(measure)metrics.create.push(elapsed(t))
    assert.equal(result.sessionId,sessionId);assert.ok(result.workspace?.workspaceId);assert.ok(Array.isArray(result.initialHistory?.records))
    t=performance.now();const opened=await rpc(who,'open',{sessionId,detail:'conversation'},ids.open);if(measure)metrics.open.push(elapsed(t))
    assert.ok(Array.isArray(opened.records))
    const selected=await rpc(who,'session.selectModel',{sessionId,provider:'org-topology',model:'fixture-chat'});assert.equal(selected.selected.model,'fixture-chat')
    const input={sessionId,requestId,mode:'queue',content:[{type:'text',text:'fixture '+requestId}]}
    t=performance.now();assert.deepEqual(await rpc(who,'send',input,ids.send),{accepted:true});if(measure)metrics.send.push(elapsed(t))
    t=performance.now();assert.deepEqual(await rpc(who,'status',{sessionId,requestId},ids.status),{state:'accepted'});if(measure)metrics.status.push(elapsed(t))
    assert.deepEqual(await rpc(who,'send',input,ids.send),{accepted:true})
    const deadline=Date.now()+16000
    for(;;){
      const history=await rpc(who,'open',{sessionId,detail:'conversation'}),json=JSON.stringify(history.records)
      if(json.includes('controlled-node-response')){
        const admissions=history.records.filter(r=>r.event.type==='agent/inbox/spliced'&&
          r.event.data.inserted?.some(message=>message.role==='user'&&message.source?.rpcId===requestId))
        assert.equal(admissions.length,1,'Retrying one logical input must insert one inbox item');break
      }
      const terminal=history.records.findLast(row=>row.event.type==='turn/end')?.event.data.reason
      assert.ok(Date.now()<deadline,`Controlled provider reply missing for sample ${iteration}: ${JSON.stringify(terminal ?? null)}`)
      await delay(100)
    }
    if(measure){
      const sql={},ownerObservations={}
      for(const [key,id] of Object.entries(ids)){
        const op=key==='open'?'history':key,observations=await samples(base,who.cookie,id)
        const record=observations.find(v=>v.operation===op&&v.status===200&&!v.aborted);assert.ok(record,`Missing primary Gateway ${op} observation`)
        assert.ok(record.sql.governance.count>0,`Missing primary governance admission for ${op}`);sql[key]=record.sql.governance
        const ownerRecords=await samples(secondary,who.cookie,id)
        const ownerRecord=ownerRecords.find(v=>v.operation===op&&v.status===200&&!v.aborted)
        assert.ok(ownerRecord,`Missing owner Gateway ${op} observation`)
        const execution=ownerRecords.find(v=>v.operation==='executionInput'&&v.status===200&&!v.aborted)
        if(key==='send'){
          assert.ok(execution?.sql.governance.count>0,'Input authorization SQL must be attributed to the same browser operation')
          for(const phase of ['sessionAuthority','agentReadiness','admissionWait','executionStamp','inboxAppend','flushReceipt','readReceipt']){
            assert.ok(Number.isFinite(ownerRecord.hostAdmission?.[phase]),`Missing durable Host phase ${phase}`)
          }
          const prior = process.env.HGW_TEST_LEGACY_PERSONAL_ADMISSION === '1'
          assert.ok(prior ? execution.sql.governance.count>=8 : execution.sql.governance.count<=3,
            `Unexpected statement count for ${prior?'legacy':'combined'} personal admission: ${execution.sql.governance.count}`)
        }
        ownerObservations[key]={sql:ownerRecord.sql.governance,phases:ownerRecord.phases,hostMs:ownerRecord.hostMs,
          hostAdmission:ownerRecord.hostAdmission,...(execution===undefined?{}:{executionInput:{durationMs:execution.durationMs,sql:execution.sql.governance}})}
      }
      sampleIds.push(ids);primarySql.push(sql);owner.push(ownerObservations)
    }
    return {sessionId,requestId}
  }
  const localDone=await triplet(local,false,0)
  for(let i=0;i<count;i++){
    // A controlled idle node replenishes credits between samples without including pressure publication in the timing window.
    await observeOwnerPressure()
    const done=await triplet(remote,true,i+1);remoteSession=done.sessionId;remoteRequest=done.requestId
  }
  const transportIds=Array.from({length:6},()=>randomUUID())
  for(const id of transportIds){
    const history=await rpc(remote,'open',{sessionId:remoteSession,detail:'conversation'},id)
    assert.ok(Array.isArray(history.records))
  }
  const transports=[]
  for(const id of transportIds){
    const observation=(await samples(base,remote.cookie,id)).find(row=>row.operation==='history'&&row.status===200&&!row.aborted)
    assert.ok(observation?.nodeTransport,'Each forwarded history read must record its transport acquisition')
    transports.push(observation.nodeTransport)
  }
  assert.ok(transports.filter(value=>value==='reused').length>=5,'Sequential history reads must reuse the node-service transport')
  assert.ok(owner.at(-1).send.sql.count>0)
  const unauthorized=await fetch(base+'/api/admit/v1/session.status?dshRuntime='+remote.id,{method:'POST',redirect:'manual',headers:{origin:base,'content-type':'application/json'},body:'{}'})
  assert.ok([302,401,403].includes(unauthorized.status));await unauthorized.arrayBuffer()
  const denied=await fetch(base+'/api/admit/v1/session.status?dshRuntime='+remote.id+'&dshTarget=personal',{method:'POST',
    headers:{cookie:local.cookie,origin:base,'content-type':'application/json'},body:JSON.stringify({type:'client-request',
      rpcId:randomUUID(),method:'session.promptStatus',payload:{sessionId:remoteSession,requestId:remoteRequest}})})
  assert.ok([403,404].includes(denied.status),'An administrator acting in the user workbench cannot open another account’s private Runtime');await denied.arrayBuffer()
  const lock=await pool.connect(),cancelId=randomUUID(),unseen=randomUUID(),ctrl=new AbortController()
  let inflight
  try{
    await lock.query('BEGIN');await lock.query('LOCK harness.users IN ACCESS EXCLUSIVE MODE')
    inflight=rpc(remote,'send',{sessionId:remoteSession,requestId:unseen,mode:'queue',content:[{type:'text',text:'cancelled fixture'}]},cancelId,ctrl.signal)
    void inflight.catch(()=>{})
    const deadline=Date.now()+8000
    for(;;){const q=await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%harness.users%' AND query ILIKE '%harness.auth_sessions%') waiting")
      if(q.rows[0].waiting)break;assert.ok(Date.now()<deadline,'Browser send must be held before user authorization');await delay(10)}
    ctrl.abort();await assert.rejects(inflight,{name:'AbortError'})
  }finally{ctrl.abort();await lock.query('ROLLBACK');lock.release()}
  assert.deepEqual(await rpc(remote,'status',{sessionId:remoteSession,requestId:unseen}),{state:'unknown'})
  assert.deepEqual(await rpc(remote,'status',{sessionId:remoteSession,requestId:remoteRequest}),{state:'accepted'})
  assert.deepEqual(await rpc(local,'status',localDone),{state:'accepted'})
  const cancelled=await samples(base,remote.cookie,cancelId);assert.ok(cancelled.some(row=>row.aborted))
  console.log(JSON.stringify({scope:'dual-gateway-host-node-agent-pg',count,operationIds:sampleIds,cancelId,
    localStartupMs:startup[0],remoteStartupMs:startup[1],[count===1?'remoteWireMs':'remoteWireP95Ms']:Object.fromEntries(Object.entries(metrics).map(([name,values])=>[name,p95(values)])),primarySql,ownerSendSql:owner.at(-1).send.sql,validManagedLease:true,localRuntimeIndependent:true,
    remoteWireP50Ms:Object.fromEntries(Object.entries(metrics).map(([name,values])=>[name,p50(values)])),rawRemoteWireMs:metrics,owner,
    primaryDbObservations:true,secondaryDbObservations:true,duplicateInputCount:1,cancelledBeforeAdmission:true,nodeTransports:transports}))
}
