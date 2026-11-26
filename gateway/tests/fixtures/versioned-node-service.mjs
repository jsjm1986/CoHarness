/** Real prepared conversations and durable admission through a primary Gateway and an outbound node. */
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
import {once} from 'node:events'
import WebSocket from 'ws'

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

async function verifyDrainingRuntimeStop(base,local,remote,generation) {
  const admin = async (path, payload, cookie = local.cookie) => {
    const response = await fetch(base + path, { method: 'POST', redirect: 'manual',
      headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    const text = await response.text()
    return { status: response.status, outcome: response.headers.get('x-dsh-runtime-shutdown-outcome'), text }
  }
  const statusPath = '/admin/api/deployment/nodes/status'
  const control = '/admin/api/runtimes/' + remote.id
  const onRemote = '?dshNode=' + remote.node
  const drained = await admin(statusPath, { nodeId: remote.node, status: 'draining' })
  assert.equal(drained.status, 200, drained.text)
  try {
    const restarted = await admin(control + '/restart' + onRemote, { generation })
    // The owner treats normal admission as unavailable while the node drains.
    assert.equal(restarted.status, 503, restarted.text)
    const anonymous = await admin(control + '/stop' + onRemote, { generation }, '')
    assert.equal(anonymous.status, 401, anonymous.text)
    const stale = await admin(control + '/stop' + onRemote, { generation: generation + 1 })
    assert.equal(stale.status, 409, stale.text)
    const stopped = await admin(control + '/stop' + onRemote, { generation })
    assert.equal(stopped.status, 200, stopped.text)
    assert.equal(stopped.outcome, 'confirmed')
    assert.deepEqual(JSON.parse(stopped.text), { runtimeId: remote.id, nodeId: remote.node,
      observedState: 'stopped', generation, shutdownOutcome: 'confirmed' })
    const boot = await admin(control + '/start' + onRemote, {})
    assert.equal(boot.status, 503, boot.text)
    const description = await call(base, local.cookie, local.id, 'host.describe', {})
    assert.equal(description.runtimeTarget.runtimeId, local.id)
    const receipt = JSON.stringify({ scope: 'node-scoped-drain', stopped: true, checkpoint: stopped.outcome,
      staleGenerationRefused: true, newWorkRefused: true, primaryStillServing: true })
    const expected = await readFile(new URL('../expected/node-scoped-drain.jsonl', import.meta.url), 'utf8')
    assert.equal(receipt + '\n', expected)
    console.log(receipt)
  } finally {
    const activated = await admin(statusPath, { nodeId: remote.node, status: 'active' })
    assert.equal(activated.status, 200, activated.text)
  }
}

async function sendWithFirstText(base, owner, sessionId, send) {
  const url = new URL('/api/events.mux', base)
  url.protocol = 'ws:'
  url.search = new URLSearchParams({ dshRuntime: owner.id, dshNode: owner.node, dshTarget: 'personal' }).toString()
  const deadline = AbortSignal.timeout(15000)
  const socket = new WebSocket(url, { headers: { cookie: owner.cookie, origin: base }, handshakeTimeout: 10000 })
  const closed = new Promise(resolve => { socket.once('close', resolve) })
  const first = Promise.withResolvers()
  let started
  const reject = error => { first.reject(error) }
  const aborted = () => { reject(deadline.reason) }
  void first.promise.catch(() => {})
  socket.on('error', reject)
  socket.once('close', () => { reject(new Error('The exact owner stream closed before the first model text.')) })
  socket.on('message', bytes => {
    try {
      const payload = JSON.parse(String(bytes)).payload
      if (started !== undefined && payload?.sessionId === sessionId && payload.type === 'session/assistant-stream'
        && payload.frame?.chunk?.type === 'text-delta') first.resolve(elapsed(started))
    } catch (error) { reject(error) }
  })
  deadline.addEventListener('abort', aborted, { once: true })
  try {
    await once(socket, 'open', { signal: deadline })
    started = performance.now()
    const result = await send()
    const acceptedMs = elapsed(started)
    return { result, acceptedMs, firstTextMs: await first.promise }
  } finally {
    deadline.removeEventListener('abort', aborted)
    socket.terminate()
    await closed
  }
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
  const metrics={create:[],open:[],send:[],firstText:[],status:[]},sampleIds=[],primarySql=[],owner=[]
  const legacy = process.env.HGW_TEST_LEGACY_PERSONAL_ADMISSION === '1'
  let delegatedReads=0
  let remoteSession,remoteRequest
  async function triplet(who,measure,iteration){
    const sessionId='session-'+randomUUID(),draftId='draft-'+randomUUID(),requestId=randomUUID(),ids={create:randomUUID(),open:randomUUID(),send:randomUUID(),status:randomUUID()}
    const created={sessionId,draftId,defaultWorkspace:true,includeWorkspace:true,includeInitialHistory:true}
    let t=performance.now();const result=await rpc(who,'create',created,ids.create);if(measure)metrics.create.push(elapsed(t))
    assert.equal(result.sessionId,sessionId);assert.ok(result.workspace?.workspaceId);assert.ok(Array.isArray(result.initialHistory?.records))
    const roots = () => pool.query(`SELECT 1 FROM harness.execution_sessions
      WHERE organization_id=$1 AND runtime_id=$2 AND session_id=$3`, [org,who.id,sessionId])
    assert.equal((await roots()).rowCount,legacy?1:0,'A fresh personal draft defers the execution root')
    t=performance.now();const opened=await rpc(who,'open',{sessionId,detail:'conversation'},ids.open);if(measure)metrics.open.push(elapsed(t))
    assert.ok(Array.isArray(opened.records))
    const selected=await rpc(who,'session.selectModel',{sessionId,provider:'org-topology',model:'fixture-chat'});assert.equal(selected.selected.model,'fixture-chat')
    const input={sessionId,requestId,mode:'queue',content:[{type:'text',text:'fixture '+requestId}]}
    if (measure) {
      const observed = await sendWithFirstText(base, who, sessionId, () => rpc(who, 'send', input, ids.send))
      assert.deepEqual(observed.result, { accepted: true })
      metrics.send.push(observed.acceptedMs)
      metrics.firstText.push(observed.firstTextMs)
    } else {
      assert.deepEqual(await rpc(who,'send',input,ids.send),{accepted:true})
    }
    t=performance.now();assert.deepEqual(await rpc(who,'status',{sessionId,requestId},ids.status),{state:'accepted'});if(measure)metrics.status.push(elapsed(t))
    assert.deepEqual(await rpc(who,'send',input,ids.send),{accepted:true})
    assert.equal((await roots()).rowCount,1,'Durable acceptance of the first input records exactly one execution root')
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
        if(key==='open'&&ownerRecord.phases.nodePreparedRead!==undefined){
          delegatedReads++
          assert.equal(ownerRecord.sql.governance.count,0,'An admitted personal history response must not query remote governance')
          assert.ok(record.phases.entryReadApproval!==undefined&&record.phases.entryReadRelease!==undefined)
        }
        const execution=ownerRecords.find(v=>v.operation==='executionInput'&&v.status===200&&!v.aborted)
        const registration=ownerRecords.find(v=>v.operation==='executionRegister'&&v.status===200&&!v.aborted)
        if(key==='create') {
          if(legacy) assert.ok(registration?.sql.governance.count>0)
          else assert.equal(registration,undefined,'Empty draft creation sends no execution registration request')
        }
        if(key==='send'){
          assert.ok(execution?.sql.governance.count>0,'Input authorization SQL must be attributed to the same browser operation')
          for(const phase of ['sessionAuthority','agentReadiness','admissionWait','executionStamp','inboxAppend','flushReceipt','readReceipt']){
            assert.ok(Number.isFinite(ownerRecord.hostAdmission?.[phase]),`Missing durable Host phase ${phase}`)
          }
          assert.ok(legacy ? execution.sql.governance.count>=8 : execution.sql.governance.count<=2,
            `Unexpected statement count for ${legacy?'legacy':'combined'} personal admission: ${execution.sql.governance.count}`)
          if(!legacy) assert.equal(registration,undefined,'The first input commits the root in the same request')
        }
        ownerObservations[key]={sql:ownerRecord.sql.governance,phases:ownerRecord.phases,hostMs:ownerRecord.hostMs,
          hostAdmission:ownerRecord.hostAdmission,...(execution===undefined?{}:{executionInput:{durationMs:execution.durationMs,sql:execution.sql.governance}}),
          ...(registration===undefined?{}:{executionRegister:{durationMs:registration.durationMs,sql:registration.sql.governance}})}
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
  const actor = (await pool.query(`SELECT u.public_id::text principal
    FROM harness.runtime_environments r JOIN harness.users u ON (r.organization_id,r.owner_id)=(u.organization_id,u.id)
    WHERE r.organization_id=$1 AND r.id=$2 AND r.owner_kind='user'`, [org, remote.id])).rows[0]
  assert.ok(actor)
  const scope = new URLSearchParams({ dshRuntime: remote.id, dshNode: remote.node, dshTarget: 'personal' })
  const auth = { cookie: remote.cookie, origin: base, 'x-dsh-expected-principal-id': actor.principal }
  const qualifiedRead = async (operationId, action) => {
    if (process.env.HGW_NODE_SERVICE_PREPARED_READ_DELEGATION !== 'on') return
    const [entry, owner] = await Promise.all([samples(base, remote.cookie, operationId), samples(secondary, remote.cookie, operationId)])
    const approved = entry.find(row => row.operation === action && row.status === 200 && !row.aborted)
    const delivered = owner.find(row => row.operation === action && row.status === 200 && !row.aborted)
    assert.ok(approved?.phases.entryReadApproval !== undefined && approved.phases.entryReadRelease !== undefined)
    assert.notEqual(delivered?.phases.nodePreparedRead, undefined, `Missing owner approval for ${action}`)
    assert.equal(delivered.sql.governance.count, 0, `Owner queried shared governance for ${action}`)
  }
  const bootstrapId = randomUUID()
  const bootstrapSearch = new URLSearchParams(scope)
  bootstrapSearch.set('dshBootstrap', '1')
  const boot = await fetch(base + '/?' + bootstrapSearch, {
    headers: { ...auth, accept: 'application/json', 'x-dsh-operation-id': bootstrapId },
  })
  assert.equal(boot.status, 200)
  assert.equal(boot.headers.get('x-dsh-principal-id'), actor.principal)
  assert.equal(boot.headers.get('x-dsh-runtime-id'), remote.id)
  const bootstrap = await boot.json()
  assert.equal(bootstrap.version, 1)
  assert.ok(bootstrap.kind === 'injections' || bootstrap.kind === 'full-index')
  await qualifiedRead(bootstrapId, 'bootstrap')
  const readFromOwner = async (method, payload) => {
    const operationId = randomUUID()
    const response = await fetch(base + '/api/' + method + '?' + scope, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'x-dsh-operation-id': operationId },
      body: JSON.stringify({ type: 'client-request', method, rpcId: randomUUID(), payload }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-dsh-runtime-id'), remote.id)
    const { result } = await response.json()
    assert.ok(result.ok)
    await qualifiedRead(operationId, ({ 'session.history': 'history', 'host.describe': 'hostDescription',
      'session.list': 'sessionList', 'workspace.list': 'workspaceList' })[method])
    return result.value
  }
  const tail = await rpc(remote, 'open', { sessionId: remoteSession, detail: 'conversation' })
  const cursor = tail.records.at(-1).event.seq
  const continuation = { sessionId: remoteSession, detail: 'conversation', beforeSeq: cursor, maxMessages: 50 }
  const reference = await rpc(remote, 'open', continuation)
  assert.ok(reference.records.length > 0 && reference.records.every(record => record.event.seq < cursor))
  assert.deepEqual((await readFromOwner('session.history', continuation)).records, reference.records)
  assert.equal((await readFromOwner('host.describe', {})).runtimeTarget.runtimeId, remote.id)
  assert.ok((await readFromOwner('session.list', {})).items.some(item => item.sessionId === remoteSession))
  assert.ok((await readFromOwner('workspace.list', {})).items.length > 0)
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
  if(process.env.HGW_NODE_SERVICE_PREPARED_READ_DELEGATION==='on'){
    assert.ok(delegatedReads>0,'The managed test connection must exercise primary-approved personal history')
    console.log(JSON.stringify({scope:'primary-approved-personal-history',delegatedReads,samples:count,ownerGovernanceQueries:0}))
  }
  if(count>1&&!legacy){
    assert.equal(owner.at(-1).send.executionInput.sql.count,1,'Known Runtime input admission must use one statement')
  }
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
  await verifyDrainingRuntimeStop(base, local, remote, Number(leases.find(row => row.runtime_id === remote.id).generation))
}
