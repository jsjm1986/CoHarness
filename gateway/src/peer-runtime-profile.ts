/** Preserve managed Runtime configuration and installed profile artifacts without importing code or following package links. */
import { lstat,opendir,readFile,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import type { ManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import { PeerBackupError } from './peer-backup-repository.ts'

const homeFiles=new Set(['cordis.patch.yml','.env','directory-grants.json','.recovery-environment.json'])
/** Fixed Runtime-owned locations; arbitrary files outside the private Runtime home remain outside this inventory. */
export function managedRuntimeProfileKey(owner:string,key:string,kind:'file'|'directory'):boolean {
  return owner==='gateway-runtime-profiles'&&key==='profiles'&&kind==='directory'||owner==='gateway-runtime-configuration'&&kind==='file'&&homeFiles.has(key)
}

/** Read a single immutable view and declare complete regular-file profile trees; linked/custom external artifacts remain explicit gaps. */
export async function nativeRuntimeProfileData(home:string,map:(path:string)=>string,maxRows:number,signal:AbortSignal):Promise<{roots:ManagedDataPath[];gaps:string[]}>{
  let rows=0
  const roots:ManagedDataPath[]=[],gaps:string[]=[]
  const entry=async(path:string)=>lstat(path).catch((error:unknown)=>{if(error instanceof Error&&'code' in error&&error.code==='ENOENT')return;throw error})
  const regular=async(path:string):Promise<boolean>=>{
    signal.throwIfAborted();if(++rows>maxRows)throw new PeerBackupError(507,'peer-backup/export-budget')
    const info=await entry(path)
    if(!info)return true
    if(info.isSymbolicLink()||!info.isFile()&&!info.isDirectory())return false
    if(info.isDirectory())for await(const child of await opendir(path))if(!await regular(join(path,child.name)))return false
    return true
  }
  const profiles=join(home,'profiles'),profile=await entry(map(profiles))
  if(profile){
    if(profile.isDirectory()&&!profile.isSymbolicLink()&&await regular(map(profiles)))roots.push({owner:'gateway-runtime-profiles',kind:'directory',path:profiles})
    else gaps.push('files:linked-runtime-profile-artifacts')
  }
  for(const key of homeFiles){const path=join(home,key),info=await entry(map(path));if(!info)continue
    if(info.isFile()&&!info.isSymbolicLink())roots.push({owner:'gateway-runtime-configuration',kind:'file',path})
    else gaps.push('files:unsafe-runtime-configuration')
  }
  return {roots,gaps}
}

const databaseKeys=new Set(['DATABASE_URL','PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGPASSFILE','PGSERVICE','PGSERVICEFILE',
  'PGSSLMODE','PGREQUIRESSL','PGSSLCOMPRESSION','PGSSLCERT','PGSSLKEY','PGSSLROOTCERT','PGSSLCRL','PGSSLCRLDIR','PGSSLNEGOTIATION',
  'PGSSLSNI','PGCHANNELBINDING','PGSSL_MIN_PROTOCOL_VERSION','PGSSL_MAX_PROTOCOL_VERSION','PGREQUIREAUTH','PGGSSENCMODE','PGKRBSRVNAME',
  'PGGSSLIB','PGCONNECT_TIMEOUT','PGCLIENTENCODING','PGOPTIONS','PGAPPNAME','PGTARGETSESSIONATTRS','PGLOADBALANCEHOSTS'])
/** Identify inherited control and database connection keys without exposing values or changing private configuration.
 * @param values - parsed node-local environment file.
 * @returns original key spellings for explicit review; unrelated prefixes such as PGP remain untouched.
 */
export function recoveredEnvironmentKeys(values:Readonly<Record<string,unknown>>):string[]{
  return Object.keys(values).filter(key=>/^(HGW_|DSH_)/u.test(key.toUpperCase())||databaseKeys.has(key.toUpperCase())).sort()
}
/** Disable inherited control-plane and database connection variables only in an unpublished disaster copy; encrypted source bytes remain intact. */
export async function suspendRecoveredEnvironment(home:string,maxBytes:number):Promise<string[]>{
  const file=join(home,'.env'),info=await lstat(file).catch((error:unknown)=>{if(error instanceof Error&&'code' in error&&error.code==='ENOENT')return;throw error})
  if(!info)return []
  if(!info.isFile()||info.isSymbolicLink()||info.size>maxBytes)throw new PeerBackupError(409,'peer-backup/environment-evidence-incomplete')
  const values=parseEnv(await readFile(file,'utf8')) as Record<string,string>,keys=recoveredEnvironmentKeys(values)
  if(!keys.length)return []
  if(keys.length>128||keys.some(key=>!/^[A-Z_][A-Z0-9_]{0,127}$/iu.test(key)))throw new PeerBackupError(409,'peer-backup/environment-evidence-incomplete')
  for(const key of keys)delete values[key]
  const encoded=Object.entries(values).map(([key,value])=>{
    // dotenv accepts multiline quoted values; a literal quote in either spelling requires manual connection/configuration review.
    const quote=!value.includes('"')?'"':!value.includes("'")?"'":!value.includes('`')?'`':undefined
    if(quote===undefined)throw new PeerBackupError(409,'peer-backup/environment-evidence-incomplete')
    return key+'='+quote+value+quote
  }).join('\n')+'\n'
  const roundtrip=parseEnv(encoded)
  if(JSON.stringify(roundtrip)!==JSON.stringify(values))throw new PeerBackupError(409,'peer-backup/environment-evidence-incomplete')
  await writeFile(file,encoded,{mode:0o600,flush:true})
  return keys.map(key=>key.toUpperCase())
}
