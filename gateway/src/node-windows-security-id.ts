/** NTFS owner and DACL comparison for files that already passed the Gateway's complete permission check. */
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {join} from 'node:path'

type ReadDescriptor=(name:string,request:number,descriptor:Buffer,capacity:number,length:Buffer)=>number
type NativeLibrary={func(abi:string,name:string,result:string,args:string[]):unknown}
let native:{read:ReadDescriptor;attributes:(path:string)=>number}|undefined

/** @param path - existing fixed-volume object under the file host's checked directory tree.
 * @returns an in-process digest of the self-relative owner and discretionary security descriptor.
 */
export function windowsSecurityId(path:string):string{
  if(!native){
    const system=process.env.SystemRoot
    if(process.platform!=='win32'||!system)throw new Error('Windows file security is unavailable.')
    const ffi=createRequire(import.meta.url)('koffi') as {load(path:string):NativeLibrary}
    native={
      read:ffi.load(join(system,'System32','advapi32.dll')).func('__stdcall','GetFileSecurityW','int32',['str16','uint32','void *','uint32','void *']) as ReadDescriptor,
      attributes:ffi.load(join(system,'System32','kernel32.dll')).func('__stdcall','GetFileAttributesW','uint32',['str16']) as (path:string)=>number,
    }
  }
  const flags=native.attributes(path)
  if(flags===0xffffffff||(flags&0x441400)!==0)throw new Error('Windows storage cannot use recalled or redirected file objects.')
  const length=Buffer.alloc(4)
  let descriptor=Buffer.alloc(1024)
  for(;;){
    const ok=native.read(path,0x5,descriptor,descriptor.length,length),size=length.readUInt32LE()
    if(ok&&size>0&&size<=descriptor.length)return createHash('sha256').update(descriptor.subarray(0,size)).digest('base64')
    if(ok||size<=descriptor.length||size>65536)throw new Error('The file security descriptor could not be verified.')
    descriptor=Buffer.alloc(size)
  }
}
