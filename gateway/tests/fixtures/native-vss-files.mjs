/** Run on a disposable Windows NTFS data volume with an operator-only staging directory. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { lstat,mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile } from 'node:fs/promises'
import { openPeerVssSnapshot } from '../../lib/peer-vss-snapshot.js'
import { snapshotManagedFiles } from '../../lib/managed-files.js'

const [parent,staging,volume]=process.argv.slice(2)
assert.ok(process.platform==='win32' && parent && staging && volume)
const dir=await mkdtemp(join(await realpath(parent),'hgw-project-'))
const ctl=new AbortController()
let view
try{
  const work=join(dir,'workspace'),extra=join(dir,'other')
  await mkdir(work);await mkdir(extra)
  const input=join(work,'foreground.txt')
  await writeFile(input,'before')
  await writeFile(join(extra,'tagged'),'body');await writeFile(join(extra,'tagged')+':hgw-test','separate stream')
  await symlink(work,join(extra,'junction'),'junction')
  view=await openPeerVssSnapshot(dir,volume,await realpath(staging),60000,ctl.signal)
  await writeFile(input,'after')
  await view.inspect([work],64)
  assert.equal(await readFile(view.map(input),'utf8'),'before')
  assert.equal(await readFile(input,'utf8'),'after')
  const bytes=await snapshotManagedFiles([{owner:'project-workspace',kind:'directory',path:view.map(work)}],undefined,ctl.signal,
    {maxEntries:64,maxBytes:4096,verifiedVssPath:view.verifiedPath})
  const source=await lstat(input,{bigint:true})
  assert.equal(bytes.files.length,1)
  assert.deepEqual(bytes.files[0].object,{device:String(source.dev),inode:String(source.ino)})
  assert.throws(()=>view.verifiedPath(view.map(extra)))
  await assert.rejects(view.inspect([join(extra,'tagged')],64))
  await assert.rejects(view.inspect([join(extra,'junction')],64))
  await view.release();await view.release()
  await assert.rejects(lstat(view.map(input)))
  console.log(JSON.stringify({provider:'vss',volatile:true,sourceCanWrite:true,sourceObjectsMatch:true,encryptedExportInputVerified:true,
    namedStreamRejected:true,reparsePointRejected:true,outsideScopeRejected:true,shadowReleased:true}))
}finally{await view?.release();await rm(dir,{recursive:true,force:true})}
