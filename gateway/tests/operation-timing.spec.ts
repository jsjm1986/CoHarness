/** Tracing shares only numeric spans and result metadata across retries. */
import { AsyncResource } from 'node:async_hooks'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { OperationTimings, forwardingMarks, observeOperationCheckout, observeOperationSql, operationPhase, recordNodeTransport, recordResourceQueueDiagnostic, timeOperation } from '../src/operation-timing.ts'
import { RuntimeLaunchTiming } from '../src/runtime-launch-timing.ts'

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
    const port=(http.address() as AddressInfo).port
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

it('correlates a native script request without a supplied ID through a body interruption', async () => {
  const ring = new OperationTimings(2)
  const resource = '/plugins/combo.js??@fixture/module/client.js&rev=0123456789ab'
  const server = createServer((req, res) => {
    void ring.run(req, res, async () => {
      if (req.url === resource) {
        res.writeHead(200, { 'content-type': 'text/javascript' })
        res.write('partial script bytes')
      } else res.end()
    })
  })
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const unversioned = await fetch(base + '/plugins/combo.js??@fixture/module/client.js')
    expect(unversioned.headers.has('x-dsh-operation-id')).toBe(false)
    await unversioned.arrayBuffer()
    const client = new AbortController()
    try {
      const response = await fetch(base + resource, { signal: client.signal })
      const id = response.headers.get('x-dsh-operation-id')
      expect(id).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u)
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

it('preserves a supplied UUID and adds no header when sampling is disabled or inapplicable', async () => {
  const ring = new OperationTimings(8), disabled = new OperationTimings(0)
  const handledIds: unknown[] = []
  const server = createServer((req, res) => {
    void (req.url?.includes('disabled=1') ? disabled : ring).run(req, res, async () => {
      handledIds.push(req.headers['x-dsh-operation-id'])
      res.end()
    })
  })
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const supplied = randomUUID().toUpperCase()
    for (const [path, header, expected] of [
      ['/?dshBootstrap=1', supplied, supplied],
      ['/?dshBootstrap=1', 'invalid', null],
      ['/?dshBootstrap=1&disabled=1', undefined, null],
      ['/?dshBootstrap=full', undefined, null],
      ['/api/echo', undefined, null],
    ] as const) {
      const res = await fetch(base + path, { headers: header === undefined ? {} : { 'x-dsh-operation-id': header } })
      expect(res.headers.get('x-dsh-operation-id')).toBe(expected)
      await res.arrayBuffer()
    }
    expect(handledIds).toEqual([supplied, 'invalid', undefined, undefined, undefined])
    expect(ring.samples()).toMatchObject([{ id: supplied, operation: 'bootstrap' }])
    expect(disabled.samples()).toEqual([])
  } finally {
    const closing = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closing
  }
})

it('correlates an explicitly sampled resource finish without generating an ID from its body', async () => {
  const ring = new OperationTimings(8)
  const id = randomUUID()
  const secret = 'private-request-metadata'
  const db = Object.assign({} as PoolClient, { query(_sql: string) { return Promise.resolve({ rows: [] }) } })
  observeOperationSql(db, 'governance')
  const server = createServer((req, res) => {
    void ring.run(req, res, async () => {
      req.resume()
      await db.query(secret)
      res.end()
    })
  })
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  try {
    await listening
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/runtime/resources`
    for (const [path, method, supplied, returned] of [
      ['request', 'POST', id, id],
      ['statuses', 'POST', id, id],
      ['finish', 'POST', id, id],
      ['finish', 'POST', undefined, null],
      ['finish', 'POST', secret, null],
      ['finish/extra', 'POST', id, null],
      ['finish', 'GET', id, null],
    ] as const) {
      const response = await fetch(`${base}/${path}`, {
        method, headers: supplied === undefined ? {} : { 'x-dsh-operation-id': supplied },
        ...(method === 'POST' ? { body: JSON.stringify({ requestId: id, secret }) } : {}),
      })
      expect(response.headers.get('x-dsh-operation-id')).toBe(returned)
      await response.arrayBuffer()
    }
    expect(ring.samples()).toEqual(ring.samples(id))
    expect(ring.samples(id)).toMatchObject(['resourceRequest', 'resourceStatuses', 'resourceFinish'].map(operation => ({
      operation, status: 200, sql: { governance: { count: 1 } },
    })))
    expect(JSON.stringify(ring.samples())).not.toContain(secret)
  } finally {
    const closing = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closing
  }
})

it('records workspaceFiles endpoints in OperationTimings and attributes per-stage SQL spans on cold launch', async () => {
  const ring = new OperationTimings(8)
  const db = Object.assign({} as PoolClient, {
    query(_sql: string) { return Promise.resolve({ rows: [] }) },
  })
  observeOperationSql(db, 'governance')
  const server = createServer((req, res) => {
    void ring.run(req, res, async () => {
      await db.query('SELECT 1')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    for (const [path, expectedOp] of [
      ['/api/workspaceFiles.list', 'workspaceFilesList'],
      ['/api/workspaceFiles.stat', 'workspaceFilesStat'],
      ['/api/workspaceFiles.read', 'workspaceFilesRead'],
      ['/api/workspaceFiles.readBytes', 'workspaceFilesReadBytes'],
    ] as const) {
      const res = await fetch(base + path, { method: 'POST', body: '{}' })
      const id = res.headers.get('x-dsh-operation-id')
      expect(id).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u)
      await res.arrayBuffer()
      expect(ring.samples(id!)).toMatchObject([{ id, operation: expectedOp, status: 200, sql: { governance: { count: 1 } } }])
    }
  } finally {
    const closing = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await closing
  }

  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  try {
    const timing = new RuntimeLaunchTiming(Date.now(), performance.now())
    await timing.run(async () => {
      await db.query('SELECT eligibility')
      await db.query('SELECT state')
      timing.mark('capacityRequested')
      await db.query('SELECT policy')
      timing.mark('policiesReady')
      timing.finish({ kind: 'user', id: 7 }, 'explicit', 'ready')
      // Late SQL after close must be ignored.
      await db.query('SELECT late')
    })
    const line = info.mock.calls.map(([value]) => String(value)).find(value => value.startsWith('[runtime-start-timing] '))
    expect(line).toBeDefined()
    const payload = JSON.parse(line!.slice('[runtime-start-timing] '.length)) as {
      sqlTotal: { count: number; elapsedMs: number }
      stageSql: Record<string, { count: number; elapsedMs: number }>
    }
    expect(payload.sqlTotal.count).toBe(3)
    expect(payload.stageSql).toEqual({
      capacityRequested: { count: 2, elapsedMs: expect.any(Number) },
      policiesReady: { count: 1, elapsedMs: expect.any(Number) },
    })
    expect(line).not.toContain('SELECT ')
  } finally { info.mockRestore() }
})

it('attributes native callbacks on a reused PostgreSQL connection to the dispatching launch only', async () => {
  const reused = new RuntimeLaunchTiming(Date.now(), performance.now())
  const launch = new RuntimeLaunchTiming(Date.now(), performance.now())
  const connection = await reused.run(async () => new AsyncResource('prewarmed-pg-connection'))
  const callbacks: Array<() => void> = []
  const nativeResult = { connection: 'pg' }
  const db = Object.assign({} as PoolClient, {
    query(_sql: string, complete: (error: null, result: object) => void) {
      callbacks.push(() => { connection.runInAsyncScope(complete, undefined, null, nativeResult) })
      return nativeResult
    },
  })
  observeOperationSql(db, 'governance')
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  try {
    const completed = vi.fn(), late = vi.fn()
    await launch.run(async () => {
      expect(db.query('SELECT eligibility', completed)).toBe(nativeResult)
      expect(db.query('SELECT late', late)).toBe(nativeResult)
    })
    expect(completed).not.toHaveBeenCalled()
    callbacks[0]!()
    expect(completed).toHaveBeenCalledExactlyOnceWith(null, nativeResult)
    launch.mark('startAdmitted')
    launch.finish({ kind: 'user', id: 7 }, 'explicit', 'ready')
    callbacks[1]!()
    expect(late).toHaveBeenCalledExactlyOnceWith(null, nativeResult)
    reused.finish({ kind: 'user', id: 8 }, 'explicit', 'ready')
    const logs = info.mock.calls.map(([line]): unknown => JSON.parse(String(line).slice('[runtime-start-timing] '.length)))
    expect(logs).toMatchObject([
      { ownerId: 7, sqlTotal: { count: 1 }, stageSql: { startAdmitted: { count: 1, elapsedMs: expect.any(Number) } } },
      { ownerId: 8, sqlTotal: { count: 0 }, stageSql: {} },
    ])
  } finally {
    connection.emitDestroy()
    info.mockRestore()
  }
})

it('records resourceQueue attribution only on resourceRequest and resourceStatuses plus resourceFinishDatabase phase', async () => {
  const ring = new OperationTimings(4)
  const http = createServer((req, res) => {
    void ring.run(req, res, async () => {
      recordResourceQueueDiagnostic({ reason: 'pressure-cpu', cpu: 0.92, memory: 'normal', eventLoopMs: 4.5, sampleCredits: 0, sampleApplied: true, observationAgeMs: 120 })
      if (req.url === '/internal/runtime/resources/finish') {
        await timeOperation('resourceFinishDatabase', async () => { await Promise.resolve() })
      }
      res.end()
    })
  })
  const started = once(http, 'listening')
  http.listen(0, '127.0.0.1')
  try {
    await started
    const port = (http.address() as AddressInfo).port
    const finishId = randomUUID()
    for (const action of ['request', 'statuses']) {
      const response = await fetch(`http://127.0.0.1:${port}/internal/runtime/resources/${action}`, { method: 'POST' })
      await response.arrayBuffer()
    }
    const finished = await fetch(`http://127.0.0.1:${port}/internal/runtime/resources/finish`, {
      method: 'POST', headers: { 'x-dsh-operation-id': finishId },
    })
    await finished.arrayBuffer()
    expect(ring.samples()).toMatchObject([
      { operation: 'resourceRequest', resourceQueue: { reason: 'pressure-cpu', cpu: 0.92, sampleCredits: 0 } },
      { operation: 'resourceStatuses', resourceQueue: { reason: 'pressure-cpu', cpu: 0.92, sampleCredits: 0 } },
      { id: finishId, operation: 'resourceFinish', phases: { resourceFinishDatabase: expect.any(Number) } },
    ])
    expect(ring.samples(finishId)[0]?.resourceQueue).toBeUndefined()
  } finally {
    const closing = once(http, 'close')
    http.close(); http.closeAllConnections()
    await closing
  }
})
