/** Tracing shares only numeric spans and result metadata across retries. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { expect,it } from 'vitest'
import type { PoolClient } from 'pg'
import { OperationTimings, forwardingMarks, observeOperationCheckout, observeOperationSql, operationPhase, recordNodeTransport, timeOperation } from '../src/operation-timing.ts'

it('preserves callback and promise results and bounds the operation ring without storing the request or SQL',async()=>{
  const ring=new OperationTimings(2)
  const secret='private-customer-title'
  const db=Object.assign({} as PoolClient,{query(_sql:string,callback?: (err:null,value:number)=>void) {
    if(callback) {callback(null,7);return}
    return Promise.resolve(8)
  }})
  observeOperationSql(db,'content')
  const http=createServer((req,res)=>{ void ring.run(req,res,async()=>{
    observeOperationCheckout('governance')({ kind: 'opened', setupMs: 0 })
    observeOperationCheckout('governance')({ kind: 'handoff' })
    observeOperationCheckout('governance')({ kind: 'failed' })
    observeOperationCheckout('content')({ kind: 'reused' })
    await timeOperation('authorize',async()=>{
      await new Promise<void>(done=>db.query(secret,(_e,result)=>{expect(result).toBe(7);done()}))
      expect(await db.query(secret)).toBe(8)
    })
    const queued=operationPhase('runtimeQueue')
    await Promise.resolve()
    queued()
    expect(await timeOperation('runtimeLiveness',async()=>true)).toBe(true)
    recordNodeTransport('reused')
    const mark=forwardingMarks()
    mark('leaseAcquired')
    await Promise.resolve()
    mark('socketAssigned')
    mark('requestWritten')
    mark('responseHeaders')
    res.setHeader('x-dsh-host-duration-ms','2.1')
    res.setHeader('x-dsh-host-prepare-ms', JSON.stringify({ bodyMs: 0.25, sessionMs: 1.5, initialHistoryMs: -1, private: secret }))
    res.end()
  })})
  const started=once(http,'listening')
  http.listen(0,'127.0.0.1')
  try {
    await started
    const port=(http.address() as import('node:net').AddressInfo).port
    const ids=[secret,randomUUID(),randomUUID(),randomUUID()]
    for(const id of ids){
      const response=await fetch('http://127.0.0.1:'+port+'/api/prepare/v1/session.history?q='+secret,
        {method:'POST',headers:{'x-dsh-operation-id':id},body:secret})
      await response.arrayBuffer()
    }
    expect(ring.samples().map(row=>row.id)).toEqual(ids.slice(2))
    expect(ring.samples(ids[2])).toMatchObject([{operation:'history',status:200,hostMs:2.1,nodeTransport:'reused',
      hostPreparation: { bodyMs: 0.25, sessionMs: 1.5 },
      startedAtMs:expect.any(Number),responseHeadersMs:expect.any(Number),
      forwarding:{leaseAcquired:expect.any(Number),socketAssigned:expect.any(Number),requestWritten:expect.any(Number),responseHeaders:expect.any(Number)},
      databaseCheckout:{governance:{opened:1,reused:1,handoffs:1,failed:1,setupMs:0,waitMs:expect.any(Number),failedMs:expect.any(Number)},
        content:{opened:0,reused:1,handoffs:0,failed:0,setupMs:0,waitMs:expect.any(Number),failedMs:0}},
      phases:{runtimeQueue:expect.any(Number),runtimeLiveness:expect.any(Number),governanceCheckout:expect.any(Number),contentCheckout:expect.any(Number)},
      sql:{content:{count:2},governance:{count:0}}}])
    const sample=ring.samples(ids[2])[0]!
    expect(sample.forwarding!.responseHeaders).toBeLessThanOrEqual(sample.responseHeadersMs!)
    expect(sample.hostPreparation).toEqual({ bodyMs: 0.25, sessionMs: 1.5 })
    expect(JSON.stringify(ring.samples())).not.toContain(secret)
  } finally {
    const closing=once(http,'close')
    http.close();http.closeAllConnections()
    await closing
  }
})

it('correlates an explicitly sampled revisioned plugin batch through a body interruption', async () => {
  const ring = new OperationTimings(2)
  const id = randomUUID()
  const resource = '/plugins/combo.js??@fixture/module/client.js&rev=0123456789ab'
  const server = createServer((req, res) => {
    void ring.run(req, res, async () => {
      if (req.url === resource && req.headers['x-dsh-operation-id'] === id) {
        res.writeHead(200, { 'content-type': 'text/javascript' })
        res.write('partial script bytes')
      } else res.end()
    })
  })
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    const unversioned = await fetch(base + '/plugins/combo.js??@fixture/module/client.js', { headers: { 'x-dsh-operation-id': id } })
    expect(unversioned.headers.has('x-dsh-operation-id')).toBe(false)
    await unversioned.arrayBuffer()
    const unsampled = await fetch(base + resource)
    expect(unsampled.headers.has('x-dsh-operation-id')).toBe(false)
    await unsampled.arrayBuffer()
    const client = new AbortController()
    try {
      const response = await fetch(base + resource, { headers: { 'x-dsh-operation-id': id }, signal: client.signal })
      expect(response.headers.get('x-dsh-operation-id')).toBe(id)
      client.abort()
      await expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'AbortError' })
      await expect.poll(() => ring.samples()).toMatchObject([
        { id, operation: 'pluginCombo', status: 200, aborted: true, responseHeadersMs: expect.any(Number) },
      ])
      const metadata = JSON.stringify(ring.samples())
      expect(metadata).not.toContain('partial script bytes')
      expect(metadata).not.toContain('0123456789ab')
    } finally { client.abort() }
  } finally {
    const closing = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closing
  }
})
