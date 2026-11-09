/** Two real browser disconnects while the destination computer is being authorized. */
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {once} from 'node:events'
import {createServer} from 'node:http'
import {connect} from 'node:net'
import {pathToFileURL} from 'node:url'

/** @param mode production JS or source regression launcher. @returns transport-open counts after the two observed disconnects. */
export async function verifyEarlyClose(mode='lib'){
  assert.ok(['src','lib'].includes(mode))
  const load=name=>import(new URL('../../'+mode+'/'+name+(mode==='src'?'.ts':'.js'),import.meta.url))
  const [{GatewayNodeServiceProxy},{loadNodeServiceConfig}]=await Promise.all([load('node-service-proxy'),load('node-service')])
  const results=[]
  for(const kind of ['http','upgrade']){
    const local=randomUUID(),node=randomUUID(),runtime=randomUUID()
    const held=Promise.withResolvers(),resume=Promise.withResolvers(),closed=Promise.withResolvers(),done=Promise.withResolvers()
    let opened=0,result
    const proxy=new GatewayNodeServiceProxy({localNodeId:local,async resolveForAccount(){
      held.resolve();await resume.promise;return {id:runtime,node:{id:node},owner:{kind:'personal',id:1}}
    }},{async open(){opened++;throw Error('The acceptance fixture terminates an unrequested upstream dial.')},
      async revalidate(){},released(){return Promise.resolve()},capacity(){return null}},4000,loadNodeServiceConfig({}))
    const serve=work=>{void work.then(value=>{result=value;done.resolve()},e=>{result=e.code;done.resolve()})}
    const actor={id:1,role:'user'},server=createServer((req,res)=>{res.once('close',closed.resolve);serve(proxy.http(req,res,actor))})
    server.on('upgrade',(req,socket,head)=>{
      socket.once('close',closed.resolve);socket.on('end',()=>socket.destroy());socket.resume()
      serve(proxy.upgrade(req,socket,head,actor))
    })
    server.listen(0,'127.0.0.1');await once(server,'listening')
    const deadline=AbortSignal.timeout(4000),timed=promise=>Promise.race([promise,new Promise((_,reject)=>{
      if(deadline.aborted)reject(deadline.reason);else deadline.addEventListener('abort',()=>reject(deadline.reason),{once:true})
    })])
    let client
    try{
      const port=server.address().port,path='/api/admit/v1/session.prompt?dshRuntime='+runtime+'&dshTarget=personal'
      client=connect(port,'127.0.0.1');await timed(once(client,'connect'))
      client.write(kind==='http'?'POST '+path+' HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}':
        'GET /api/events.host?dshRuntime='+runtime+' HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
      await timed(held.promise);client.destroy();await timed(closed.promise);resume.resolve();await timed(done.promise)
      results.push({kind,opened,result})
    }finally{client?.destroy();resume.resolve();await proxy.close();server.closeAllConnections();await new Promise(ok=>server.close(ok))}
  }
  assert.deepEqual(results,[{kind:'http',opened:0,result:'node-service/cancelled'},{kind:'upgrade',opened:0,result:'node-service/cancelled'}])
  return results
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)console.log(JSON.stringify(await verifyEarlyClose(process.argv[2]??'lib')))
