/** In-place project storage verification for scheduled work, memory and profile plugins. */
import {createHash} from 'node:crypto'
import {lstat,readFile,realpath} from 'node:fs/promises'
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path'
import {parseDocument} from 'yaml'
import {readManagedDataPaths} from '@deepseek-ai/dsh-managed-data'
import type {PoolClient} from 'pg'
import type {GatewayConfig} from './config.ts'
import type {PostgresRuntimeContext} from './postgres/runtime-context.ts'
import {readObservedState,type PluginDesiredState} from './plugin-state.ts'
import {normalizeManagedRoots} from './managed-files.ts'
import {assertLocalMount,NodeContentUnavailable,type NodeContentBinding,type NodeContentStore} from './node-content-store.ts'
import {recordNodeContentDomainReceipt,type NodeContentDomainChecks} from './node-content-publication.ts'

type CheckInput=Parameters<NonNullable<NodeContentDomainChecks['memory']>>[0]
interface Witness {owner:string;path:string;anchorPath:string;device:string;inode:string;missing:boolean}
export interface NodePluginProofInput {
  binding: NodeContentBinding
  home: string
  workspace: string
  owner: string
  paths: readonly string[]
  installAnchor: string
  configuration: readonly unknown[]
}
export type NodePluginProof = (input: NodePluginProofInput) => Promise<readonly string[]>
export type NodePluginProofs = Pick<ReadonlyMap<string,NodePluginProof>,'get'>
function within(root:string,path:string):boolean {
  const rest=relative(root,path)
  return rest==='' || !isAbsolute(rest) && rest!=='..' && !rest.startsWith('..'+sep)
}
function unavailable(message:string):never {throw new NodeContentUnavailable(message)}
async function optionalStat(path:string){
  try {return await lstat(path,{bigint:true})} catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error}
}
function patchEntries(value:unknown):Array<{id:string;name?:string;config?:Record<string,unknown>;disabled?:boolean}>{
  if (Array.isArray(value)) return value.flatMap(patchEntries)
  if (!value || typeof value!=='object') return []
  const row=value as Record<string,unknown>
  const current=typeof row.id==='string'?[{id:row.id,...typeof row.name==='string'?{name:row.name}:{},
    ...row.config&&typeof row.config==='object'?{config:row.config as Record<string,unknown>}:{},...row.disabled===true?{disabled:true}:{}}]:[]
  return [...current,...patchEntries(row.insert),...patchEntries(row.prepend),...patchEntries(row.append),...patchEntries(row.entries)]
}

/** A non-default plugin is eligible when its actual installed owner can prove the locations it writes. */
export class NodeProjectFiles {
  constructor(private readonly cfg:Pick<GatewayConfig,'projectRuntimesRoot'|'dshRepoRoot'|'runtimeRequestTimeoutMs'|'guardPatch'|'modelGovernancePackage'>,
    private readonly context:PostgresRuntimeContext,private readonly store:Pick<NodeContentStore,'read'|'write'>,
    private readonly providers:NodePluginProofs=new Map()) {}

  private async witness(owner:string,path:string,allowAbsent:boolean):Promise<Witness>{
    if (!isAbsolute(path) || resolve(path)!==path) unavailable('A managed project path is not a normalized absolute path.')
    let at=path
    while (!await optionalStat(at)) {
      if (!allowAbsent || at===dirname(at)) unavailable('A previously recorded project storage path is missing.')
      at=dirname(at)
    }
    const info=await lstat(at,{bigint:true}),canonical=await realpath(at)
    if (info.isSymbolicLink() || canonical!==at || !info.isFile()&&!info.isDirectory()) unavailable('A project storage location has changed identity or contains a symbolic link.')
    await assertLocalMount(canonical,this.cfg.runtimeRequestTimeoutMs)
    return {owner,path,anchorPath:at,device:String(info.dev),inode:String(info.ino),missing:at!==path}
  }

  private async inspect(control:Pick<PoolClient,'query'>,local:PoolClient,b:NodeContentBinding,override?:PluginDesiredState|null|'observed', historical=false):Promise<{roots:Witness[];effective:PluginDesiredState}>{
    if (b.organizationId!==this.context.organizationId || b.nodeId!==this.context.nodeId) unavailable('The owning computer must verify its project files.')
    const project=(await control.query<{pid:string;started:boolean;live:boolean}>(`SELECT p.public_id::text pid,i.started_at IS NOT NULL started,i.observed_state='ready' live FROM harness.projects p
      JOIN harness.instances i ON (i.organization_id,i.project_id)=(p.organization_id,p.id) WHERE p.organization_id=$1 AND p.id=$2 AND i.runtime_id=$3 AND i.assigned_node_id=$4`,
    [b.organizationId,b.projectId,b.runtimeId,b.nodeId])).rows[0]
    if (!project) unavailable('The project allocation is missing from this computer.')
    const space=(await local.query<{root_path:string;entries:PluginDesiredState['entries']|null;bundles:string[]|null}>(`SELECT s.root_path,ps.entries,ps.bundles
      FROM node_content.spaces s LEFT JOIN node_content.plugin_states ps ON ps.organization_id=s.organization_id AND ps.runtime_id=s.runtime_id
      WHERE s.organization_id=$1 AND s.project_id=$2 AND s.runtime_id=$3 AND s.volume_id=$4 AND s.writer_epoch=$5`,
    [b.organizationId,b.projectId,b.runtimeId,b.volumeId,b.writerEpoch])).rows[0]
    if (!space) unavailable('The assigned project files have no verified volume.')
    const canonical=await normalizeManagedRoots([{owner:'gateway-runtime',kind:'directory',path:resolve(this.cfg.projectRuntimesRoot)}])
    const runtimeRoot=canonical[0]!.path,home=join(runtimeRoot,project.pid,'dsh'),workspace=space.root_path
    const requiresInventory=project.live || historical && project.started
    const roots=[await this.witness('workspace',workspace,false),await this.witness('runtime',home,!requiresInventory),
      await this.witness('storage',join(home,'storages'),!requiresInventory)]
    const releases=['base','web-app'].map(bundle=>join(this.cfg.dshRepoRoot,'packages','bundle',bundle))
    const inventory=new Set<string>(),bundleNames=new Set<string>()
    const defaults=await Promise.all(releases.map(async dir=>{
      const doc=parseDocument(await readFile(join(dir,'cordis.patch.yml'),'utf8'))
      if (doc.errors.length) unavailable('Cannot verify the installed project profile.')
      const manifest=JSON.parse(await readFile(join(dir,'package.json'),'utf8')) as {name:string}
      bundleNames.add(manifest.name)
      return patchEntries(doc.toJS({maxAliasCount:16}))
    }))
    // The Gateway appends these shipped overlays to the project's home profile before it launches.
    const stockGovernance=join(this.cfg.dshRepoRoot,'plugins','dsh-model-governance'),stockGuard=join(this.cfg.dshRepoRoot,'plugins','dsh-directory-guard','cordis.patch.yml')
    const managedPatches=[...(resolve(this.cfg.modelGovernancePackage)===resolve(stockGovernance)?[join(stockGovernance,'cordis.patch.yml')]:[]),
      ...(this.cfg.guardPatch && resolve(this.cfg.guardPatch)===resolve(stockGuard)?[stockGuard]:[])]
    const deployment=await Promise.all(managedPatches.map(async path=>{
      const doc=parseDocument(await readFile(path,'utf8'))
      if(doc.errors.length)unavailable('The installed Gateway policy overlay could not be verified.')
      return patchEntries(doc.toJS({maxAliasCount:16}))
    }))
    const roster=[...defaults.flat(),...deployment.flat()]
    if (!roster.some(row=>row.name==='@deepseek-ai/dsh-storage-json'&&row.config?.root==="dshHomePath('storages')")
      || !roster.some(row=>row.name==='@deepseek-ai/dsh-storage-domain'&&row.config?.backend==='json')) unavailable('The installed project storage provider requires its own locality proof.')
    for(const row of roster){inventory.add(row.id);if(row.name)inventory.add(row.name)}
    for(const name of ['@deepseek-ai/dsh-schedule','@deepseek-ai/dsh-tool-schedule','@deepseek-ai/dsh-collaboration-gateway',
      '@deepseek-ai/dsh-collaboration-context','@deepseek-ai/dsh-session-persistence-gateway','@deepseek-ai/dsh-gateway-execution/desktop-availability',
      '@deepseek-ai/dsh-computer-use','@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp']) inventory.add(name)
    const manifest=join(home,'managed-data.jsonl')
    const records=await optionalStat(manifest)?readManagedDataPaths(manifest):[]
    if (requiresInventory && !records.some(r=>r.owner==='@deepseek-ai/dsh-storage-json'&&r.path===join(home,'storages'))) unavailable('The running profile has not reported its memory and schedule storage.')
    const externalOwners=new Set<string>()
    for(const record of records) {
      if (!within(home,record.path)&&!within(workspace,record.path)) externalOwners.add(record.owner)
      roots.push(await this.witness(record.owner,record.path,!requiresInventory))
    }
    const profile=join(home,'profiles','web')
    for(const path of [join(profile,'package.json'),join(profile,'cordis.patch.yml')])if(await optionalStat(path))await this.witness('profile',path,false)
    const observed=await readObservedState(profile)
    const current=override==='observed'?observed:override===undefined?(space.entries===null?observed:{entries:space.entries,bundles:space.bundles??[]}):override
    const effective=current??{entries:[],bundles:[]}
    const unknown=new Set([...externalOwners,...effective.bundles.filter(n=>!bundleNames.has(n))])
    const configuration:Array<{layer:string;rows:ReturnType<typeof patchEntries>}>=[]
    for(const entry of effective.entries) if(!entry.disabled&&!inventory.has(entry.name??entry.id)) unknown.add(entry.name??entry.id)
    // Hand-authored patch rows can change storage independently of the database's desired enablement rows.
    for(const file of [join(home,'profiles','web','cordis.patch.yml'),join(home,'cordis.patch.yml')]) {
      if(!await optionalStat(file))continue
      await this.witness('profile',file,false)
      const content=await readFile(file,'utf8')
      const doc=parseDocument(content)
      if(doc.errors.length) unavailable('The effective project profile could not be verified.')
      const rows=patchEntries(doc.toJS({maxAliasCount:16}))
      const proofDoc=parseDocument(content,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(value:string)=>({dynamicExpression:value})}]})
      configuration.push({layer:file===join(home,'cordis.patch.yml')?'home':'profile',rows:patchEntries(proofDoc.toJS({maxAliasCount:16}))})
      for(const entry of rows) {
        if(entry.disabled)continue
        if((entry.id==='storage-json'||entry.name==='@deepseek-ai/dsh-storage-json')&&entry.config?.root!==undefined&&entry.config.root!=="dshHomePath('storages')"&&entry.config.root!==join(home,'storages')
          || (entry.id==='storage-domain'||entry.name==='@deepseek-ai/dsh-storage-domain')&&entry.config?.backend!==undefined&&entry.config.backend!=='json') unavailable('Project storage was redirected outside its verified provider.')
        if(!inventory.has(entry.name??entry.id)&&entry.name)unknown.add(entry.name)
      }
    }
    for(const owner of unknown) {
      const prove=this.providers.get(owner)
      if(!prove) unavailable('An enabled custom plugin or bundle has no verified storage provider.')
      const ids=new Set(effective.entries.filter(row=>row.name===owner).map(row=>row.id))
      for(const layer of configuration)for(const row of layer.rows)if(row.name===owner)ids.add(row.id)
      const inputs=configuration.map(({layer,rows})=>({layer,entries:rows.filter(row=>row.name===owner||ids.has(row.id))})).filter(layer=>layer.entries.length)
      const locations=await prove({binding:b,home,workspace,owner,paths:records.filter(r=>r.owner===owner).map(r=>r.path),
        installAnchor:join(this.cfg.dshRepoRoot,'apps','cli','package.json'),configuration:inputs})
      for(const path of locations)roots.push(await this.witness(owner,path,!requiresInventory))
    }
    return {roots:roots.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path))),effective}
  }

  private async anchors(local:PoolClient,b:NodeContentBinding,roots:Witness[],mode:'publish'|'read'|'pin'):Promise<boolean>{
    const saved=(await local.query<Witness>(`SELECT owner,path,anchor_path "anchorPath",device,inode,missing FROM node_content.project_file_anchors
      WHERE organization_id=$1 AND runtime_id=$2 AND project_id=$3`,[b.organizationId,b.runtimeId,b.projectId])).rows
    const known=new Map(saved.map(row=>[row.owner,row]))
    let pin=false
    for(const current of roots.filter(r=>['workspace','runtime','storage'].includes(r.owner))) {
      const old=known.get(current.owner)
      if(!old) {
        if(mode!=='publish')unavailable('The selected project storage has no published filesystem identity.')
        await local.query(`INSERT INTO node_content.project_file_anchors(organization_id,project_id,runtime_id,owner,path,anchor_path,device,inode,missing)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[b.organizationId,b.projectId,b.runtimeId,current.owner,current.path,current.anchorPath,current.device,current.inode,current.missing])
      } else {
        if(old.path!==current.path)unavailable('The selected project storage path changed.')
        const stat=await optionalStat(old.anchorPath)
        if(!stat || stat.isSymbolicLink() || String(stat.dev)!==old.device || String(stat.ino)!==old.inode
          || !old.missing && (current.missing || old.device!==current.device || old.inode!==current.inode)) unavailable('The selected project directory was replaced.')
        if(old.missing&&!current.missing) {
          pin=true
          if(mode!=='read')await local.query(`UPDATE node_content.project_file_anchors SET anchor_path=$4,device=$5,inode=$6,missing=false
            WHERE organization_id=$1 AND runtime_id=$2 AND owner=$3 AND missing`,[b.organizationId,b.runtimeId,current.owner,current.anchorPath,current.device,current.inode])
        }
      }
    }
    return pin
  }

  /** Verify memory, scheduled state and plugin files in place without opening a Runtime or changing a timer.
   * @param input - exact project allocation and current transactions.
   * @param domain - storage owner recording its verified migration evidence.
   */
  async publication(input:CheckInput,domain:'memory'|'plugins'):Promise<void>{
    const data=await this.inspect(input.control,input.local,input.binding,undefined,input.migration!==undefined)
    await this.anchors(input.local,input.binding,data.roots,'publish')
    if (!input.migration) return
    const config=(await input.local.query<{sha:string}>(`SELECT manifest->'plugin_states'->>'sha256' sha FROM node_content.migration_snapshots
      WHERE id=$1 AND job_id=$2 AND verified AND materialized`,[input.migration.snapshotId,input.migration.jobId])).rows[0]
    if(!config?.sha) unavailable('The project plugin configuration has no verified source copy.')
    await recordNodeContentDomainReceipt(input.local,{snapshotId:input.migration.snapshotId,sourceRevision:input.migration.sourceRevision,
      domain,records:data.roots.length,digest:createHash('sha256').update(JSON.stringify({domain,...data,configuration:config.sha})).digest()})
  }

  /** Check one prospective composition in the node transaction already holding the project's writer fence. */
  async verifyWith(local:PoolClient,binding:NodeContentBinding,state:PluginDesiredState|null):Promise<void>{
    const data=await this.inspect(this.context.pool,local,binding,state)
    await this.anchors(local,binding,data.roots,'pin')
  }

  /** Recheck a selected project's effective profile on launch or when its desired composition changes.
   * @param binding - authenticated project.
   * @param state - prospective configuration, or omission to verify the saved state.
   */
  async verify(binding:NodeContentBinding,state?:PluginDesiredState|null|'observed',generation?:number):Promise<void>{
    const pending=await this.store.read(binding,async local=>{
      const data=await this.inspect(this.context.pool,local,binding,state)
      return this.anchors(local,binding,data.roots,'read')
    },undefined,generation)
    if(pending)await this.store.write(binding,async local=>{
      const data=await this.inspect(this.context.pool,local,binding,state)
      await this.anchors(local,binding,data.roots,'pin')
    },generation)
  }
}
