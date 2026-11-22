/** Fixed governance rebuilding inventory. New tables and columns need an explicit disposition before any package can be complete. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ProjectNameKeyring } from './project-name-keyring.ts'

export const GOVERNANCE_REBUILD_SCHEMA_VERSION = 148
const dispositions = {safe:'restore-safe',reset:'reset-and-review',node:'node-owned',ephemeral:'ephemeral'} as const
export type GovernanceColumnDisposition = typeof dispositions[keyof typeof dispositions]
export interface GovernanceRebuildColumn {name:string;disposition:GovernanceColumnDisposition}
function columns(groups:Partial<Record<keyof typeof dispositions,string>>):GovernanceRebuildColumn[]{
  return Object.entries(groups).flatMap(([kind,names])=>names.split(',').map(name=>({name,disposition:dispositions[kind as keyof typeof dispositions]}))).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)
}
/** Frozen inventory for existing schema-135 rebuilding points. */
const schema135Tables = {
  audit_events: columns({"node": "resource_type,resource_id,source_ip,user_agent,detail", "ephemeral": "legacy_id", "safe": "id,organization_id,occurred_at,actor_user_id,action,request_id,outcome,status_code"}),
  auth_sessions: columns({"ephemeral": "id,organization_id,user_id,token_hash,created_at,expires_at,absolute_expires_at,last_seen_at,revoked_at,revoked_reason,source_ip,user_agent"}),
  backup_records: columns({"node": "path,managed_files,error", "safe": "id,organization_id,format,migration_version,write_epoch,size_bytes,sha256,status,created_by,created_at,verified_at,restored_at"}),
  cluster_control: columns({"reset": "mode", "node": "reason", "safe": "organization_id,maintenance_epoch,write_epoch,actor_user_id,entered_at,updated_at"}),
  compute_nodes: columns({"reset": "principal_public_key", "ephemeral": "last_heartbeat_at,access_applied_revision,maintenance_applied_epoch,inflight_writes", "safe": "id,organization_id,name,created_at,status"}),
  computer_use_permissions: columns({"safe": "organization_id,node_id,user_id,enabled,revision,updated_at"}),
  content_files: columns({"node": "id,organization_id,owner_user_id,session_id,kind,local_path,sha256,byte_length,media_type,created_at,project_id,runtime_id,runtime_namespace"}),
  conversation_append_batches: columns({"node": "batch_id,session_id,first_seq,event_count,checksum,created_at,organization_id,runtime_id,runtime_namespace"}),
  conversation_archive_commands: columns({"node": "id,organization_id,action,requested_by_user_id,requested_at,desired_revision,status,error,applied_at,idempotency_key,archive_id"}),
  conversation_archive_file_cleanup: columns({"node": "id,organization_id,local_path,attempts,next_attempt_at,lease_until,last_error,created_at,node_id,archive_id"}),
  conversation_archive_records: columns({"node": "organization_id,root_session_id,runtime_kind,runtime_public_id,project_id,creator_user_id,title,workspace_path,workspace_title,workspace_position,message_count,state,archived_at,archived_by_user_id,restored_at,restored_by_user_id,trashed_at,trashed_by_user_id,purge_after,sync_revision,sync_state,last_sync_error,updated_at,record_kind,runtime_id,node_id,legacy_unassigned,archive_id"}),
  conversation_archive_search: columns({"node": "organization_id,session_id,event_seq,role,content,occurred_at,archive_id,runtime_id,content_nul_parts"}),
  conversation_draft_reservations: columns({"node": "organization_id,scope_key,draft_id,session_id,user_id,project_id,cwd,visibility,agent_preset,created_at,updated_at,lease_expires_at,ssh_target_id,runtime_id,runtime_namespace"}),
  conversation_events: columns({"node": "session_id,seq,event_type,occurred_at,event,payload_bytes,organization_id,runtime_id,runtime_namespace,query_fields"}),
  conversation_interaction_responses: columns({"node": "organization_id,interaction_kind,interaction_id,conversation_id,responder_user_id,outcome,responded_at,call_id,runtime_id,runtime_namespace"}),
  conversation_migrated_events: columns({"node": "migration_id,session_id,seq,event_type,occurred_at,event,payload_bytes,organization_id,runtime_id,runtime_namespace"}),
  conversation_migrations: columns({"node": "id,session_id,migration_id,from_format_version,to_format_version,source_revision,event_count,created_at,organization_id,runtime_id,runtime_namespace"}),
  conversation_participants: columns({"node": "organization_id,conversation_id,user_id,first_contributed_at,last_contributed_at,contribution_count,runtime_id,runtime_namespace"}),
  conversation_search: columns({"node": "session_id,event_seq,role,content,occurred_at,organization_id,runtime_id,runtime_namespace,content_nul_parts"}),
  conversation_sessions: columns({"node": "id,organization_id,creator_user_id,project_id,parent_session_id,session_format_version,created_at,updated_at,closed_at,cwd,seed_length,origin,delegation_depth,agent_preset,title,status,next_seq,event_count,total_payload_bytes,version,visibility,root_session_id,draft,has_visible_content,visible_content_seq,last_prompt_at,ssh_target_id,runtime_id,runtime_namespace"}),
  deployment_operations: columns({"node": "detail,error", "safe": "id,organization_id,kind,status,node_name,created_by,created_at,started_at,finished_at"}),
  deployment_topology: columns({"reset": "primary_origin,legacy_initialization_required", "safe": "organization_id,revision,updated_at,enabled,primary_node_id"}),
  desktop_access_policies: columns({"safe": "organization_id,user_id,project_id,enabled,revision,node_id"}),
  desktop_grants: columns({"ephemeral": "grant_id,resource_key,fencing,holder_key,holder_json,request_id,state,reason,acquired_at,heartbeat_at,stopping_at,released_at"}),
  desktop_queue: columns({"ephemeral": "queue_id,resource_key,position,holder_key,holder_json,request_id,state,queued_at,settled_at,grant_id"}),
  desktop_resources: columns({"safe": "resource_key,node,desktop,fencing_seq,queue_seq", "reset": "state", "node": "state_note", "ephemeral": "updated_at"}),
  desktop_session_confirmations: columns({"ephemeral": "organization_id,runtime_kind,runtime_public_id,session_id,node_id,generation,desktop,user_id,user_policy_revision,project_policy_revision,confirmed_at,runtime_id,id"}),
  document_catalog: columns({"node": "id,organization_id,scope_kind,scope_user_id,scope_project_id,runtime_doc_id,directory_id,name,bytes,media_type,modified_at_ms,owner_user_id,owner_source,lineage_root_id,source_catalog_id,state,legacy,created_at,updated_at,deleted_at,trashed_at,trashed_by_user_id,restored_at,restored_by_user_id,purge_after,purged_at,purged_by_user_id,runtime_incarnation_id,runtime_revision,trash_action_id,missing_at,node_id"}),
  document_history: columns({"node": "id,organization_id,catalog_id,operation_id,actor_user_id,event_kind,detail,created_at"}),
  document_operation_items: columns({"node": "id,organization_id,operation_id,source_catalog_id,target_catalog_id,source_runtime_doc_id,source_name,target_runtime_doc_id,status,error_code,error_message,attempt,created_at,updated_at"}),
  document_operations: columns({"node": "id,organization_id,actor_user_id,operation_kind,source_scope_kind,source_user_id,source_project_id,target_scope_kind,target_user_id,target_project_id,status,requested_count,completed_count,failed_count,detail,created_at,updated_at,completed_at,node_id"}),
  document_projection_checkpoints: columns({"node": "organization_id,root_id,scope_kind,scope_user_id,scope_project_id,sequence,ordinal,updated_at,node_id"}),
  document_scope_placement: columns({"safe": "organization_id,node_id,scope_kind,scope_id,root_id,volume_id,writer_epoch,publication_revision,project_runtime_id"}),
  document_scope_writers: columns({"ephemeral": "organization_id,node_id,scope_kind,scope_id,published"}),
  document_transfer_delivery: columns({"ephemeral": "organization_id,node_id,root_id,operation_id,direction,item_id,counterpart_node_id,actor_id,incarnation_id,succeeded,created_at,delivered_at,claim,retry_at,last_error"}),
  execution_inputs: columns({"node": "id,organization_id,runtime_kind,runtime_public_id,session_id,message_id,kind,content_hash,created_by_user_id,actor_user_ids,previous_input_id,created_at,entered_at,runtime_id"}),
  execution_relays: columns({"node": "organization_id,runtime_kind,runtime_public_id,session_id,message_id,request_hash,runtime_id,id"}),
  execution_scopes: columns({"node": "id,organization_id,runtime_kind,runtime_public_id,session_id,fingerprint,revision,input_ids,primary_actor_user_id,unverified,created_at,runtime_id"}),
  execution_sessions: columns({"node": "organization_id,runtime_kind,runtime_public_id,session_id,parent_session_id,is_seeded,actor_witnesses,primary_actor_user_id,unverified_history,inheritance_hash,revision,created_at,updated_at,runtime_id,id"}),
  governance_rebuild_accounts: columns({"safe": "operation_id,organization_id,user_id,source_role,source_user_status,source_member_status,source_deleted_at,source_password_available"}),
  governance_rebuild_decisions: columns({"safe": "id,operation_id,organization_id,revision,subject_kind,subject_id,decision,approved_by,approved_at"}),
  governance_rebuild_execution_approvals: columns({"safe": "review_id,organization_id,approved_by,approved_at,mode"}),
  governance_rebuild_execution_holds: columns({"safe": "operation_id,organization_id,runtime_id"}),
  governance_rebuild_execution_item_approvals: columns({"safe": "review_id,item_digest,organization_id,approved_by,evidence_reference,approved_at"}),
  governance_rebuild_execution_requests: columns({"safe": "operation_id,organization_id,request_id,requested_by,requested_at,status,review_id,error_code"}),
  governance_rebuild_execution_reviews: columns({"safe": "id,operation_id,organization_id,runtime_id,target_node_id,target_epoch,point_id,policy_digest,composition_digest,old_session_count,items,blockers,created_at"}),
  governance_rebuild_nodes: columns({"safe": "operation_id,organization_id,node_id,source_status"}),
  governance_rebuild_operations: columns({"safe": "id,organization_id,source_node_id,target_node_id,point_id,manifest_digest,schema_digest,source_watermark,source_topology_revision,recovery_epoch,bootstrap_user_id,isolation_method,evidence_reference,state,review_revision,unrestored_domains,created_at,released_at"}),
  governance_rebuild_runtimes: columns({"safe": "id,operation_id,organization_id,runtime_id,node_id,owner_kind,owner_id,source_generation,writer_epoch,volume_id,created_at"}),
  governance_rebuild_reconfiguration: columns({safe:'operation_id,table_name,record_digest,safe_record'}),
  governance_rebuild_data_bindings: columns({safe:'runtime_operation_id,organization_id,runtime_id,node_id,binding_id,evidence_digest,old_session_count,source_generation,created_at'}),
  governance_rebuild_binding_requests: columns({safe:'runtime_operation_id,organization_id,request_id,requested_by,requested_at',ephemeral:'status,error_code'}),
  instances: columns({"reset": "port,applied_policy_revision,allocation_state,provisioning_state", "ephemeral": "runtime_token_hash,runtime_token_issued_at,node_connection_id,node_connection_epoch,launch_stamp,last_heartbeat_at,started_at,last_activity_at,legacy_user_id", "safe": "id,organization_id,user_id,assigned_node_id,observed_state,generation,observed_generation,policy_revision,created_at,updated_at,project_id,stop_reason,runtime_id,storage_layout,desired_state"}),
  login_attempts: columns({"node": "source_ip", "safe": "id,organization_id,username,occurred_at,succeeded"}),
  memberships: columns({"safe": "organization_id,user_id,role,status,created_at"}),
  memory_access_policies: columns({"safe": "organization_id,user_id,project_id,enabled,revision,node_id"}),
  model_catalog: columns({"safe": "id,organization_id,provider_key,model_key,display_name,enabled,created_at,updated_at,provider_id"}),
  model_intake_tokens: columns({"ephemeral": "user_id,token_hash,created_at"}),
  model_prices: columns({"safe": "id,model_id,effective_at,currency,input_per_million,output_per_million,cache_read_per_million,cache_write_per_million,created_at"}),
  model_project_access: columns({"safe": "organization_id,project_id,model_id,allowed,created_at,updated_at"}),
  model_providers: columns({"reset": "base_url,profile,auth_mode,credential_ref", "safe": "id,organization_id,provider_key,display_name,driver,protocol,source,revision,created_at,updated_at,status"}),
  model_registration_events: columns({"node": "provider_key,model_key", "safe": "event_id,organization_id,user_id,occurred_at,received_at,action,scope"}),
  model_role_access: columns({"safe": "organization_id,role,model_id,allowed"}),
  model_runtime_intake_tokens: columns({"ephemeral": "organization_id,runtime_id,node_id,user_id,project_id,token_hash,created_at"}),
  model_usage: columns({"node": "purpose,session_id,credential_source", "safe": "event_id,organization_id,user_id,occurred_at,received_at,model_id,provider_key,model_key,credential_class,status,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,estimated_cost,company_cost,project_id,actor_user_id,pricing_status"}),
  model_usage_alerts: columns({"safe": "user_id,period_start,metric,threshold,created_at"}),
  model_user_access: columns({"safe": "organization_id,user_id,model_id,allowed"}),
  node_agent_enrollments: columns({"ephemeral": "id,organization_id,node_id,revision,token_hash,created_by,created_at,expires_at,consumed_at"}),
  node_agents: columns({"ephemeral": "credential_hash,revoked_at,connection_id,lease_expires_at,last_seen_at", "reset": "attachment_state,execution_ready", "safe": "organization_id,node_id,revision,platform,architecture,connection_epoch"}),
  node_content_volumes: columns({"safe": "organization_id,node_id,volume_id,cluster_id,database_oid"}),
  node_journal_deliveries: columns({"ephemeral": "organization_id,project_id,node_id,runtime_id,request_id,operation_id,completed,queued_at"}),
  node_recovery_quarantines: columns({"safe": "organization_id,node_id,operation_id"}),
  node_resource_gateways: columns({"ephemeral": "organization_id,node_id,owner_id,generation,device,inode"}),
  node_resource_requests: columns({"ephemeral": "organization_id,node_id,runtime_kind,runtime_public_id,generation,sequence,kind,actor_public_id,project_public_id,session_id,fingerprint,state,user_turn,project_turn,queued_bytes,created_at,deadline,granted_at,operation_id,origin_kind,scope_id,principal_admin"}),
  node_resource_runtimes: columns({"ephemeral": "organization_id,node_id,runtime_kind,runtime_public_id,generation,last_sequence,runtime_id"}),
  node_resource_state: columns({"safe": "organization_id,node_id", "reset": "limits", "ephemeral": "pressure,sampled_at,valid_until,credits,next_turn,admitted,rejected,completed,cancelled,timed_out,reclaimed,wait_ms_total,wait_ms_max,runtime_starts_admitted,sampled_before"}),
  node_user_accounts: columns({"node": "home_path", "safe": "organization_id,node_id,user_id,created_at"}),
  organization_model_credentials: columns({"reset": "organization_id,provider_id,key_version,nonce,ciphertext,auth_tag,created_at,updated_at"}),
  organizations: columns({"reset": "digest_model", "safe": "id,slug,display_name,default_time_zone,created_at,updated_at,model_configuration_revision,access_revision,status"}),
  outbox: columns({"ephemeral": "id,organization_id,topic,aggregate_id,payload,available_at,attempts,completed_at,created_at"}),
  password_credentials: columns({"reset": "must_change_password", "safe": "user_id,password_hash,password_version,changed_at"}),
  peer_backup_points: columns({"safe": "id,organization_id,policy_id,revision,writer_epoch,watermark,snapshot_id,manifest_digest,covered_count,gap_count,gap_types,repository_bytes,available_bytes,protected_through,confirmed_at"}),
  peer_backup_policies: columns({"ephemeral": "append_hash,recovery_hash,next_capture_at", "safe": "id,organization_id,scope_kind,scope_id,source_node_id,target_node_id,tier,revision,quota_bytes,created_at,updated_at,enabled"}),
  peer_backup_work: columns({"ephemeral": "id,policy_id,organization_id,revision,kind,node_id,point_id,status,phase,pending_bytes,error_code,created_at,finished_at,claim,lease_expires_at,recovery_ms"}),
  personal_directory_placement: columns({"safe": "runtime_id,organization_id,node_id,owner_id"}),
  personal_document_imports: columns({"safe": "organization_id,node_id,user_id,root_id,volume_id,actor_id,catalog_digest,physical_digest,source_count,history_count,sequence,ordinal,approved_at"}),
  personal_recovery_document_receipts: columns({"safe": "operation_id,organization_id,user_id,source_node_id,root_id,source_volume_id,source_epoch,target_node_id,target_volume_id,target_epoch,document_digest,created_at"}),
  personal_recovery_execution_approvals: columns({"safe": "review_id,organization_id,approved_by,approved_at,mode"}),
  personal_recovery_execution_holds: columns({"safe": "operation_id,organization_id,runtime_id"}),
  personal_recovery_execution_item_approvals: columns({"safe": "review_id,item_digest,organization_id,approved_by,evidence_reference,approved_at"}),
  personal_recovery_execution_requests: columns({"ephemeral": "status,error_code", "safe": "operation_id,organization_id,request_id,requested_by,requested_at,review_id"}),
  personal_recovery_execution_reviews: columns({"safe": "id,operation_id,organization_id,runtime_id,target_node_id,target_epoch,point_id,policy_digest,composition_digest,old_session_count,items,blockers,created_at"}),
  personal_recovery_operations: columns({"ephemeral": "retry_at,last_error", "safe": "id,organization_id,user_id,runtime_id,policy_id,policy_revision,point_id,approved_by,source_node_id,source_generation,source_epoch,target_node_id,target_epoch,source_document_root,source_volume_id,source_document_epoch,target_volume_id,target_document_epoch,manifest_digest,point_revision,phase,target_files_digest,target_evidence_digest,target_document_digest,document_receipt_operation_id,target_verified_at,target_activated_at,activation_approved_by,activation_approved_at,suspended_environment_keys,old_session_count,created_at,published_at"}),
  personal_recovery_policy_approvals: columns({"safe": "id,operation_id,organization_id,policy_revision,phase,approved_by,approved_at"}),
  plugin_access_policies: columns({"safe": "organization_id,user_id,project_id,enabled,revision,node_id"}),
  plugin_states: columns({"reset": "entries,bundles", "safe": "organization_id,user_id,project_id,revision,updated_at,runtime_id"}),
  project_content_copy_jobs: columns({"safe": "id,organization_id,project_id,runtime_id,node_id,volume_id,registered_xid,source_revision,published,publication_xid,source_cluster_id,source_database_oid"}),
  project_content_placement: columns({"safe": "organization_id,project_id,node_id,runtime_id,volume_id,writer_epoch,source_retirement"}),
  project_invitations: columns({"reset": "status", "safe": "id,organization_id,project_id,invitee_user_id,inviter_user_id,access_mode,expires_at,created_at,responded_at"}),
  project_journal: columns({"node": "organization_id,project_id,id,kind,period_key,content,activity_count,period_start,period_end,model,generated_at,created_at,updated_at,invalidated_at"}),
  project_journal_materials: columns({"node": "organization_id,project_id,session_id,entry_id,receipt,runtime_id,runtime_namespace"}),
  project_journal_requests: columns({"node": "organization_id,node_id,project_id,project_public_id,request_id,operation_id,actor_public_id,occurred_at,provider,model,credential_source,request,response,completed,status,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,delivered_at,request_session"}),
  project_journal_state: columns({"node": "organization_id,project_id,watermark_ts,watermark_session,watermark_seq,last_run_at,generating_since,last_error,updated_at,generation_id,watermark_runtime_namespace"}),
  project_members: columns({"safe": "organization_id,project_id,user_id,access_mode,created_at,updated_at"}),
  project_model_catalog: columns({"node": "id,organization_id,project_id,provider_id,provider_key,model_key,display_name,enabled,created_at,updated_at"}),
  project_model_credentials: columns({"node": "organization_id,project_id,provider_id,key_version,nonce,ciphertext,auth_tag,created_at,updated_at"}),
  project_model_intake_tokens: columns({"ephemeral": "project_id,token_hash,created_at"}),
  project_model_providers: columns({"node": "id,organization_id,project_id,provider_key,display_name,driver,protocol,base_url,auth_mode,credential_ref,status,revision,profile,created_at,updated_at"}),
  project_mounts: columns({"node": "local_path,canonical_path", "reset": "status", "safe": "organization_id,project_id,node_id,created_at"}),
  project_name_claims: columns({"safe": "organization_id,project_id,node_id,key_id,mac,name_revision"}),
  project_name_handoffs: columns({"ephemeral": "challenge_hash,organization_id,node_id,project_id,actor_public_id,operation,expires_at"}),
  project_name_keys: columns({"safe": "organization_id,key_id,fingerprint"}),
  project_name_policies: columns({"safe": "organization_id,revision,state,active_key,next_key,normalization"}),
  project_quotas: columns({"safe": "project_id,token_limit,company_cost_limit"}),
  project_recovery_cleanups: columns({"safe": "operation_id,organization_id,node_id,volume_id,completed_at"}),
  project_recovery_execution_approvals: columns({"safe": "review_id,organization_id,approved_by,approved_at,mode"}),
  project_recovery_execution_holds: columns({"safe": "operation_id,organization_id,runtime_id,blockers"}),
  project_recovery_execution_item_approvals: columns({"safe": "review_id,item_digest,organization_id,approved_by,evidence_reference,approved_at"}),
  project_recovery_execution_requests: columns({"ephemeral": "status,error_code", "safe": "operation_id,organization_id,request_id,requested_by,requested_at,review_id"}),
  project_recovery_execution_reviews: columns({"safe": "id,operation_id,organization_id,runtime_id,target_node_id,target_epoch,point_id,policy_digest,composition_digest,old_session_count,items,blockers,created_at"}),
  project_recovery_execution_transfers: columns({"safe": "operation_id,organization_id,runtime_id,source_review_id,source_governance_review_id,created_at"}),
  project_recovery_isolations: columns({"safe": "operation_id,organization_id,source_node_id,source_generation,source_epoch,point_id,policy_revision,method,evidence_reference,confirmed_by,confirmed_at,acknowledge_data_loss"}),
  project_recovery_operations: columns({"ephemeral": "retry_at,last_error", "safe": "id,organization_id,project_id,runtime_id,policy_id,point_id,policy_revision,approved_by,source_node_id,source_volume_id,source_epoch,target_node_id,target_volume_id,target_epoch,manifest_digest,point_revision,phase,retirement_approved_by,retirement_approved_at,target_port_base,target_files_digest,source_files_digest,target_verified_at,target_schedule_digest,old_fenced_at,stopped_generation,stop_operation_id,target_activated_at,source_schedule_digest,published_at,created_at,recovery_mode,suspended_environment_keys,target_execution_transfer_digest"}),
  project_recovery_policy_approvals: columns({"safe": "sequence,organization_id,operation_id,policy_revision,approved_by,approved_at"}),
  project_source_retirement_evidence: columns({"safe": "review_id,domain,inventory_digest,proof_digest,signer_fingerprint,verified_at,observed_resources,recorded_at,recorded_by"}),
  project_source_retirement_reviews: columns({"safe": "id,organization_id,project_id,runtime_id,node_id,volume_id,writer_epoch,job_id,source_revision,source_cluster_id,source_database_oid,node_snapshot_id,backup_inventory_digest,requested_by,policy_digest,owner_coverage_digest,opened_at"}),
  project_usage_alerts: columns({"safe": "project_id,period_start,metric,threshold,created_at"}),
  projects: columns({"node": "name", "ephemeral": "legacy_id,content_creation_xid", "safe": "id,organization_id,status,created_by,version,created_at,updated_at,public_id,origin,owner_user_id,model_access_default_allowed,ui_theme_policy,project_model_configuration_revision,kind,logical_name_revision,logical_name_id,steward_node_id"}),
  push_deliveries: columns({"ephemeral": "organization_id,session_id,event_seq,device_id,status,attempts,last_error,created_at,sent_at,updated_at,runtime_id,runtime_namespace"}),
  push_devices: columns({"reset": "id,organization_id,user_id,token,platform,device_id,app_version,created_at,updated_at,last_seen_at,provider"}),
  recovery_source_isolations: columns({"safe": "operation_id,organization_id,scope_kind,scope_id,runtime_id,source_node_id,source_generation,source_epoch,point_id,policy_revision,method,evidence_reference,confirmed_by,confirmed_at,acknowledge_data_loss,project_isolation_id"}),
  role_quotas: columns({"safe": "organization_id,role,token_limit,company_cost_limit"}),
  runtime_allocation_policies: columns({"safe": "id,organization_id,user_id,max_total,max_per_node,revision,override_enabled"}),
  runtime_allocation_receipts: columns({"safe": "organization_id,request_id,runtime_id,node_id,user_id,actor_user_id,created_at"}),
  runtime_destructive_operations: columns({"ephemeral": "organization_id,runtime_id,node_id,generation,operation_id,gateway_owner_id,gateway_generation,quiescent_at"}),
  runtime_environments: columns({"safe": "id,organization_id,owner_kind,owner_id,node_id,created_at,retired_at,storage_layout"}),
  runtime_owner_generations: columns({"safe": "organization_id,node_id,owner_kind,owner_id,last_generation"}),
  runtime_workspace_catalog: columns({"node": "organization_id,runtime_id,generation,revision,items,updated_at,conversations"}),
  schema_migrations: columns({"ephemeral": "version,name,checksum,applied_at"}),
  ssh_access_policies: columns({"safe": "organization_id,user_id,project_id,enabled,revision,node_id"}),
  ssh_target_shares: columns({"safe": "organization_id,target_id,project_id,created_by,created_at"}),
  ssh_targets: columns({"safe": "id,organization_id,public_id,revision,created_by,created_at,updated_at", "reset": "name,host,node,helper,helper_hash,workspace,bootstrap_path,bootstrap_hash,request_timeout_ms,max_frame_bytes,max_pending,lease_ms,enabled,password_ref"}),
  steward_access_policies: columns({"safe": "organization_id,user_id,project_id,enabled,revision,node_id"}),
  steward_query_log: columns({"node": "id,organization_id,project_id,runtime_generation,statement,classification,dry_run,approval_interaction_id,responder_user_id,status,row_count,result_bytes,error,created_at,runtime_id,runtime_namespace"}),
  terminal_access_policies: columns({"safe": "organization_id,user_id,project_id,enabled,revision,node_id"}),
  terminal_session_grants: columns({"ephemeral": "grant_id,organization_id,node_id,runtime_kind,runtime_public_id,generation,session_id,user_id,user_policy_revision,project_policy_revision"}),
  tunnel_access: columns({"safe": "organization_id,node_id,revision", "reset": "mode,desired,state,public_url,hostname,domain,zone_id,account_id,tunnel_id,api_token_cipher,run_token_cipher", "node": "last_error", "ephemeral": "started_at,updated_at"}),
  user_preferences: columns({"safe": "organization_id,user_id,locale_preference,theme_preference,busy_enter,revision,migrated_at,created_at,updated_at,chat_content_width,chat_font_size,chat_full_width,transcript_view,performance_usage,link_opening,font_size,code_font_size,terminal_font_size,text_font_family,code_font_family,terminal_font_family,theme_fonts_migrated_at"}),
  user_quotas: columns({"safe": "user_id,token_mode,token_limit,company_cost_mode,company_cost_limit"}),
  users: columns({"node": "home_path", "ephemeral": "legacy_id", "safe": "id,organization_id,username,display_name,created_at,updated_at,public_id,deleted_at,auto_review_eligible,personal_runtime_allocation,status"}),
  webhook_delivery_aliases: columns({"ephemeral": "organization_id,endpoint_id,delivery_id,receipt_id,received_at"}),
  webhook_delivery_receipts: columns({"ephemeral": "id,organization_id,endpoint_id,delivery_id,request_hash,configuration_revision,node_id,execution_user_id,runtime_kind,runtime_public_id,state,session_id,error_code,received_at,updated_at,event,runtime_id"}),
  webhook_endpoints: columns({"safe": "id,organization_id,public_id,execution_user_id,runtime_kind,runtime_public_id,revision,created_by,created_at,updated_at,runtime_id,node_id", "reset": "name,provider,source,events,actions,agent_preset,permission_preset,model_provider,model_id,model_max_tokens,intake_limit,intake_window_ms,replay_window_ms,max_body_bytes,key_version,nonce,ciphertext,auth_tag,enabled,repositories,project_visibility", "node": "title_template,prompt_template,workspace_path"}),
  webhook_intake_windows: columns({"ephemeral": "organization_id,endpoint_id,started_at,accepted"}),
} as const
/** Frozen column inventory for schema-136 rebuilding points. */
const schema136Tables = {
  ...schema135Tables,
  project_recovery_operations: [...schema135Tables.project_recovery_operations, ...columns({safe:'repository_node_id'})].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0),
  personal_recovery_operations: [...schema135Tables.personal_recovery_operations, ...columns({safe:'repository_node_id'})].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0),
  peer_backup_recovery_access: columns({ephemeral:'id,organization_id,policy_id,policy_revision,point_id,repository_node_id,reader_node_id,credential_hash,topology_revision,write_epoch,connection_epoch,node_credential_hash,approved_by,expires_at,revoked_at,created_at'}),
  peer_recovery_node_protocols: columns({ephemeral:'organization_id,node_id,protocol,project_ready,personal_ready,topology_revision,write_epoch,connection_epoch,node_credential_hash,expires_at'}),
} as const
/** Frozen column inventory for schema-139 rebuilding points. */
const schema139Tables = {
  ...schema136Tables,
  // Runtime-reported observations stay node-owned; the runtime's next report restores them.
  plugin_inventory: columns({"node":"payload,generation,updated_at","safe":"organization_id,runtime_id"}),
} as const
/** Literal names are the only columns the rebuilding exporter or importer may address. */
const schema143Tables = {
  ...schema139Tables,
  peer_backup_policies: columns({
    "ephemeral": "append_hash,recovery_hash,next_capture_at,receiver_capacity,receiver_capacity_valid_until,retirement_pending",
    "safe": "id,organization_id,scope_kind,scope_id,source_node_id,target_node_id,tier,revision,quota_bytes,created_at,updated_at,enabled,capture_stopped_at,retirement_point_id,retired_at",
  }),
} as const
const schema144Tables = {
  ...schema143Tables,
  push_deliveries: columns({
    "ephemeral": "organization_id,session_id,event_seq,device_id,status,attempts,last_error,created_at,sent_at,updated_at,runtime_id,runtime_namespace,provider_msg_id,delivered_at,opened_at",
  }),
} as const
export const governanceRebuildTables = {
  ...schema144Tables,
  conversation_draft_reservations: columns({"node":"organization_id,scope_key,draft_id,session_id,user_id,project_id,cwd,visibility,agent_preset,created_at,updated_at,lease_expires_at,ssh_target_id,runtime_id,runtime_namespace,model_selection"}),
} as const
export type GovernanceRebuildTable = keyof typeof governanceRebuildTables
type GovernanceInventoryTables = Partial<Record<GovernanceRebuildTable,readonly GovernanceRebuildColumn[]>>
function inventory(tables:GovernanceInventoryTables){
  const dispositions=Object.entries(tables).map(([table,columns])=>({table,columns})).sort((a,b)=>a.table<b.table?-1:a.table>b.table?1:0)
  return {tables,dispositions,digest:createHash('sha256').update(JSON.stringify(dispositions)).digest('hex')}
}
const schema135Inventory=inventory(schema135Tables)
const schema136Inventory=inventory(schema136Tables)
const schema139Inventory=inventory(schema139Tables)
const schema143Inventory=inventory(schema143Tables)
const schema144Inventory=inventory(schema144Tables)
const currentInventory=inventory(governanceRebuildTables)
/** Resolve only reviewed immutable payload inventories; no newer-schema fallback is permitted.
 * @param version - final migration version sealed into the source package.
 * @returns its literal inventory, or undefined for an unsupported package.
 */
export function governanceRebuildInventory(version:number){
  return version===135?schema135Inventory
    :version===136||version===137||version===138?schema136Inventory
    :version===139||version===140||version===141||version===142?schema139Inventory
    :version===143?schema143Inventory
    :version===144||version===145||version===146||version===147?schema144Inventory
    :version===GOVERNANCE_REBUILD_SCHEMA_VERSION?currentInventory:undefined
}
/** Stable per-column decisions also accompany the encrypted package for administrator review. */
export const governanceRebuildDispositions = currentInventory.dispositions
export const governanceRebuildSchemaDigest = currentInventory.digest
/** These domains require new configuration or node-owned evidence; a governance package does not contain business data. */
export const governanceRebuildUnrestoredDomains = [
  'credentials:browser-and-runtime-sessions','credentials:node-admission-and-enrollment',
  'configuration:organization-model-connections','configuration:plugin-desired-state',
  'configuration:ssh-and-webhook','configuration:node-local-paths','configuration:public-access',
  'execution:pending-work-and-device-leases','data:node-business-domains','audit:content-bearing-detail',
  'authorization:computer-project-model-and-plugin-grants','authorization:organization-roles',
] as const
const hash=z.string().regex(/^[a-f0-9]{64}$/u)
export const governanceRebuildManifestSchema=z.object({
  format:z.literal('governance-rebuild-v1'),version:z.literal(1),organizationId:z.uuid(),sourceNodeId:z.uuid(),
  schemaMigrations:z.array(z.object({version:z.number().int().positive(),checksum:hash}).strict()).min(1).max(GOVERNANCE_REBUILD_SCHEMA_VERSION),
  schemaDigest:hash,watermark:z.string().regex(/^\d+$/u),capturedAt:z.iso.datetime(),
  records:z.object({file:z.literal('governance-rebuild.jsonl'),sha256:hash,rows:z.number().int().nonnegative(),bytes:z.number().int().nonnegative()}).strict(),
  files:z.array(z.object({role:z.literal('project-name-keyring'),file:z.literal('governance-private/project-name-keyring.json'),sha256:hash,bytes:z.number().int().positive().max(16384)}).strict()).max(1),
  dispositions:z.array(z.object({table:z.string(),columns:z.array(z.object({name:z.string(),disposition:z.enum(['restore-safe','reset-and-review','node-owned','ephemeral'])}).strict())}).strict()),
  unrestoredDomains:z.array(z.string()),
}).strict()
export type GovernanceRebuildManifest=z.infer<typeof governanceRebuildManifestSchema>
export interface GovernanceRebuildRecord {table:GovernanceRebuildTable;row:Record<string,unknown>}
export interface GovernanceRebuildLimits {maxBytes:number;maxRows:number}
export interface GovernanceRebuildPackage {
  manifest:GovernanceRebuildManifest
  /** Consume to completion inside the import transaction; the stream verifies its final digest before completing. */
  records():AsyncGenerator<GovernanceRebuildRecord>
  /** Private equality keys remain on the restoring computer and are never included in an Admin response. */
  keyring?:ProjectNameKeyring
}
/** Return only explicitly retained columns; restore logic supplies closed admission defaults separately.
 * @param table - a statically known governance table.
 * @param version - reviewed source version; exports default to the installed schema.
 * @returns sorted names permitted in this table's payload.
 */
export function governanceRebuildSafeColumns(table:GovernanceRebuildTable,version=GOVERNANCE_REBUILD_SCHEMA_VERSION):string[]{
  const inventory=governanceRebuildInventory(version)
  if(!inventory)throw new Error('Unsupported governance rebuilding schema')
  return (inventory.tables[table]??[]).filter(column=>column.disposition==='restore-safe').map(column=>column.name)
}
