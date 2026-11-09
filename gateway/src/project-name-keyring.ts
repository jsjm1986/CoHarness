/** Owner-private, immutable organization keyring generations. Key material stays on the designated primary. */
import { constants } from 'node:fs'
import { link, open, realpath, rm, stat } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { privateDirectoryState, privateFileState, syncStateDirectory } from './node-private-file.ts'

export const projectNameKeyId = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/u).refine(value=>!['__proto__','constructor','prototype'].includes(value))
const schema = z.object({version:z.literal(1),organizationId:z.uuid(),ownerNodeId:z.uuid(),
  keys:z.record(projectNameKeyId,z.string().regex(/^[A-Za-z0-9+/]{43}=$/u))}).strict()
export type ProjectNameKeyring = z.infer<typeof schema>
const maxBytes=16*1024

/** @param file - absolute canonical private keyring path. @param organizationId - expected organization. @param nodeId - expected primary.
 * @returns the verified local keyring. Credentials must never be logged or sent to another Gateway.
 */
export async function readProjectNameKeyring(file:string,organizationId:string,nodeId:string):Promise<ProjectNameKeyring>{
  if (!isAbsolute(file) || file!==await realpath(file)) throw new Error('Keyring path is not canonical.')
  const handle=await open(file,constants.O_RDONLY | (process.platform==='win32'?0:constants.O_NOFOLLOW))
  try {
    if (await privateFileState(file,await handle.stat(),maxBytes)!=='private') throw new Error('Keyring file is not private.')
    const ring=schema.parse(JSON.parse(await handle.readFile('utf8')))
    if (ring.organizationId!==organizationId || ring.ownerNodeId!==nodeId) throw new Error('Keyring belongs to another entry.')
    return ring
  } finally { await handle.close() }
}

/** Create a new private keyring generation without modifying an existing file.
 * @param options - verified primary, public key identifier, unused canonical destination and optional preceding generation.
 */
export async function createProjectNameKeyring(options:{organizationId:string;nodeId:string;keyId:string;file:string;previous?:string}):Promise<void>{
  const org=z.uuid().parse(options.organizationId), node=z.uuid().parse(options.nodeId), id=projectNameKeyId.parse(options.keyId)
  const dir=dirname(options.file)
  if (!isAbsolute(options.file) || await realpath(dir)!==dir || await privateDirectoryState(dir,await stat(dir))!=='private') {
    throw new Error('Create the keyring in an owner-private canonical directory.')
  }
  const ring= options.previous ? await readProjectNameKeyring(options.previous,org,node) : {version:1 as const,organizationId:org,ownerNodeId:node,keys:{} as Record<string,string>}
  if (Object.hasOwn(ring.keys,id)) throw new Error('Key ID already exists.')
  const key=randomBytes(32)
  try { ring.keys[id]=key.toString('base64') } finally { key.fill(0) }
  const data=Buffer.from(JSON.stringify(ring)+'\n')
  const temp=join(dir,'.keyring-'+randomUUID())
  try {
    if (data.length>maxBytes) throw new Error('The new keyring exceeds the file limit.')
    const output=await open(temp,'wx',0o600)
    try {
      if (await privateFileState(temp,await output.stat(),maxBytes)!=='private') throw new Error('Keyring output must inherit a private ACL.')
      await output.writeFile(data)
      await output.sync()
    } finally { await output.close() }
    await link(temp,options.file)
    await syncStateDirectory(dir)
  } finally { data.fill(0); await rm(temp,{force:true}) }
}
