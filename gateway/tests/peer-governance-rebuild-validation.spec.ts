/** Persisted rebuilding metadata accepts only its reviewed management fields, including nested historical review receipts. */
import { randomUUID } from 'node:crypto'
import { expect,it } from 'vitest'
import { governanceRebuildInventory,governanceRebuildSafeColumns,type GovernanceRebuildTable } from '../src/peer-governance-rebuild-manifest.ts'
import { governanceRebuildRecordDigest,parseGovernanceRebuildRecord } from '../src/peer-governance-rebuild-validation.ts'
import { governanceRebuildDefaults } from '../src/governance-rebuild-import.ts'

const org=randomUUID()
function row(table:GovernanceRebuildTable,values:Record<string,unknown>={}){
  return Object.fromEntries(governanceRebuildSafeColumns(table).map(name=>[name,name==='organization_id'?org:values[name]??null]))
}
it('retains the shipped schema-135 inventory and excludes transient recovery approvals from new packages',()=>{
  expect(governanceRebuildInventory(135)?.digest).toBe('e9676310059367d8348d7696617006344b6d330c57bc45b4220be1d23683fa7b')
  expect(governanceRebuildInventory(135)?.dispositions).toHaveLength(154)
  expect(governanceRebuildInventory(136)?.dispositions).toHaveLength(156)
  expect(governanceRebuildInventory(137)).toEqual(governanceRebuildInventory(136))
  expect(governanceRebuildInventory(138)).toEqual(governanceRebuildInventory(137))
  expect(governanceRebuildInventory(140)).toEqual(governanceRebuildInventory(139))
  expect(governanceRebuildInventory(141)).toEqual(governanceRebuildInventory(140))
  expect(governanceRebuildInventory(142)).toEqual(governanceRebuildInventory(141))
  expect(governanceRebuildInventory(143)?.digest).toBe('9f441b2c745143ea68d2a7bc9f6457d50570a1e6ab4f36bcf75b77905ada0f93')
  expect(governanceRebuildInventory(144)).toEqual(governanceRebuildInventory(145))
  expect(governanceRebuildInventory(145)).toEqual(governanceRebuildInventory(146))
  expect(governanceRebuildInventory(146)).toEqual(governanceRebuildInventory(147))
  for(const version of [134,148])expect(governanceRebuildInventory(version)).toBeUndefined()
  for(const name of ['provider_msg_id','delivered_at','opened_at']){
    expect(governanceRebuildInventory(143)?.tables.push_deliveries).not.toContainEqual({name,disposition:'ephemeral'})
    expect(governanceRebuildInventory(145)?.tables.push_deliveries).toContainEqual({name,disposition:'ephemeral'})
  }
  expect(governanceRebuildSafeColumns('peer_backup_policies',142)).not.toContain('capture_stopped_at')
  expect(governanceRebuildSafeColumns('peer_backup_policies',143)).toEqual(expect.arrayContaining([
    'capture_stopped_at','retirement_point_id','retired_at',
  ]))
  for (const field of ['retirement_pending','receiver_capacity','receiver_capacity_valid_until'])
    expect(governanceRebuildSafeColumns('peer_backup_policies',143)).not.toContain(field)
  for(const table of ['peer_backup_recovery_access','peer_recovery_node_protocols'] as const){
    expect(governanceRebuildSafeColumns(table)).toEqual([])
    expect(()=>parseGovernanceRebuildRecord({table,row:{}},org)).toThrow('governance-rebuild-invalid')
  }
})

it.each(['project_recovery_operations','personal_recovery_operations'] as const)('imports %s from its exact historical fields without changing the source point',table=>{
  const receiver=randomUUID()
  const old=Object.fromEntries(governanceRebuildSafeColumns(table,135).map(name=>[name,name==='organization_id'?org:null]))
  Object.assign(old,{target_node_id:receiver,suspended_environment_keys:[]})
  if(table==='project_recovery_operations')Object.assign(old,{recovery_mode:'disaster',phase:'prepared'})
  const record=parseGovernanceRebuildRecord({table,row:old},org,135)
  expect(governanceRebuildDefaults(record,new Map(),135)).toEqual({repository_node_id:receiver,...(table==='project_recovery_operations'?{phase:'preparing'}:{})})
  expect(record.row).not.toHaveProperty('repository_node_id')
  expect(()=>parseGovernanceRebuildRecord({table,row:old},org)).toThrow('governance-rebuild-invalid')
  expect(()=>parseGovernanceRebuildRecord({table,row:{...old,repository_node_id:receiver}},org,135)).toThrow('governance-rebuild-invalid')
  const current=parseGovernanceRebuildRecord({table,row:{...old,repository_node_id:receiver}},org)
  expect(governanceRebuildDefaults(current,new Map())).toEqual({})
})

it('keeps original grant decisions as reference rows but rejects extra authority, paths and malformed grant values',()=>{
  const table='computer_use_permissions',grant=row(table,{node_id:randomUUID(),user_id:randomUUID(),enabled:true,revision:'4',updated_at:'2026-11-16T00:00:00.000Z'})
  expect(parseGovernanceRebuildRecord({table,row:grant},org).row.enabled).toBe(true)
  const archive=row('governance_rebuild_reconfiguration',{operation_id:randomUUID(),table_name:table,record_digest:governanceRebuildRecordDigest(grant),safe_record:grant})
  expect(parseGovernanceRebuildRecord({table:'governance_rebuild_reconfiguration',row:archive},org).row.safe_record).toEqual(grant)
  for(const changed of [{...grant,enabled:'true'},{...grant,home_path:'/private/account/data'},{...grant,node_id:'private-business-text'},
    {...grant,organization_id:randomUUID()}])expect(()=>parseGovernanceRebuildRecord({table,row:changed},org)).toThrow('governance-rebuild-invalid')
  expect(()=>parseGovernanceRebuildRecord({table:'governance_rebuild_reconfiguration',row:{...archive,record_digest:'0'.repeat(64)}},org)).toThrow('governance-rebuild-invalid')
  expect(()=>parseGovernanceRebuildRecord({table:'governance_rebuild_reconfiguration',row:{...archive,table_name:'governance_rebuild_reconfiguration'}},org)).toThrow('governance-rebuild-invalid')
})

it('preserves sealed execution review metadata without admitting private plugin configuration or unsealed connection names',()=>{
  const sum='1'.repeat(64),item={id:sum,itemDigest:sum,kind:'plugin',status:'eligible',name:'custom-plugin:abcdef123456',artifactSha256:sum,configurationSha256:sum,dependencyClosure:true}
  const table='governance_rebuild_execution_reviews',review=row(table,{items:[item],blockers:[],suspended_environment_keys:['PGPASSWORD']})
  expect(parseGovernanceRebuildRecord({table,row:review},org).row.items).toEqual([item])
  for(const changed of [{...item,name:'file:/private/space/plugin.ts'},{...item,config:{password:'private-value'}},{...item,dependencyClosure:false}])
    expect(()=>parseGovernanceRebuildRecord({table,row:{...review,items:[changed]}},org)).toThrow('governance-rebuild-invalid')
  expect(()=>parseGovernanceRebuildRecord({table,row:{...review,blockers:['/private/workspace'] }},org)).toThrow('governance-rebuild-invalid')
})
