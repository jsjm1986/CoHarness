/** Tracing shares only numeric spans and result metadata across retries. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { expect,it } from 'vitest'
import type { PoolClient } from 'pg'
import { OperationTimings, observeOperationSql, timeOperation } from '../src/operation-timing.ts'

it('preserves callback and promise results and bounds the operation ring without storing the request or SQL',async()=>{
  const ring=new OperationTimings(2)
  const secret='private-customer-title'
  const db={query(_sql:string,callback?: (err:null,value:number)=>void) {
    if(callback) {callback(null,7);return}
    return Promise.resolve(8)
  }}
  observeOperationSql(db as unknown as PoolClient,'content')
  const http=createServer((req,res)=>{ void ring.run(req,res,async()=>{
    await timeOperation('authorize',async()=>{
      await new Promise<void>(done=>db.query(secret,(_e,result)=>{expect(result).toBe(7);done()}))
      expect(await db.query(secret)).toBe(8)
    })
    res.setHeader('x-dsh-host-duration-ms','2.1')
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
    expect(ring.samples(ids[2])).toMatchObject([{operation:'history',status:200,hostMs:2.1,sql:{content:{count:2},governance:{count:0}}}])
    expect(JSON.stringify(ring.samples())).not.toContain(secret)
  } finally {
    const closing=once(http,'close')
    http.close();http.closeAllConnections()
    await closing
  }
})
