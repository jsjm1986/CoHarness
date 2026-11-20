import { PERSONAL_RECOVERY_RESTORE_PREFIX, PERSONAL_RECOVERY_RESTORE_SUFFIX } from './peer-backup-personal-restore-guard.ts'
/** Maintenance cannot restore an older writer or erase the operator's irreversible takeover evidence. */
const identify = `has_ops:=to_regclass('harness.project_recovery_operations') IS NOT NULL;
  IF to_regclass('harness.schema_migrations') IS NOT NULL THEN SELECT checksum INTO digest FROM harness.schema_migrations WHERE version=115; END IF;
  IF has_ops IS DISTINCT FROM (digest IS NOT NULL) THEN RAISE EXCEPTION 'Project recovery schema and migration 115 disagree'; END IF;`
const additions = `has_additions:=to_regclass('harness.project_recovery_policy_approvals') IS NOT NULL;
  IF to_regclass('harness.schema_migrations') IS NOT NULL THEN SELECT checksum INTO extra_digest FROM harness.schema_migrations WHERE version=119; END IF;
  IF has_additions IS DISTINCT FROM (extra_digest IS NOT NULL)
    OR has_additions IS DISTINCT FROM (to_regclass('harness.project_recovery_cleanups') IS NOT NULL)
    THEN RAISE EXCEPTION 'Project recovery approvals and migration 119 disagree'; END IF;`
const disaster = `has_disaster:=to_regclass('harness.project_recovery_isolations') IS NOT NULL;
  IF to_regclass('harness.schema_migrations') IS NOT NULL THEN SELECT checksum INTO disaster_digest FROM harness.schema_migrations WHERE version=130; END IF;
  IF has_disaster IS DISTINCT FROM (disaster_digest IS NOT NULL)
    OR has_disaster IS DISTINCT FROM (to_regclass('harness.node_recovery_quarantines') IS NOT NULL)
    OR has_disaster IS DISTINCT FROM (to_regclass('harness.project_recovery_execution_holds') IS NOT NULL)
    THEN RAISE EXCEPTION 'Disaster recovery authority and migration 130 disagree'; END IF;`
const executionTables = ['project_recovery_execution_requests','project_recovery_execution_reviews',
  'project_recovery_execution_approvals','project_recovery_execution_item_approvals'] as const
const execution = `has_execution:=to_regclass('harness.project_recovery_execution_requests') IS NOT NULL;
  IF to_regclass('harness.schema_migrations') IS NOT NULL THEN SELECT checksum INTO execution_digest FROM harness.schema_migrations WHERE version=131; END IF;
  IF has_execution IS DISTINCT FROM (execution_digest IS NOT NULL)
    ${executionTables.slice(1).map(table => `OR has_execution IS DISTINCT FROM (to_regclass('harness.${table}') IS NOT NULL)`).join('\n')}
    THEN RAISE EXCEPTION 'Execution recovery authority and migration 131 disagree'; END IF;`
const transfers = `has_transfers:=to_regclass('harness.project_recovery_execution_transfers') IS NOT NULL;
  IF to_regclass('harness.schema_migrations') IS NOT NULL THEN SELECT checksum INTO transfer_digest FROM harness.schema_migrations WHERE version=132; END IF;
  IF has_transfers IS DISTINCT FROM (transfer_digest IS NOT NULL)
    THEN RAISE EXCEPTION 'Execution transfer authority and migration 132 disagree'; END IF;`
const sourceIsolations = `has_source_isolations:=to_regclass('harness.recovery_source_isolations') IS NOT NULL;
  IF to_regclass('harness.schema_migrations') IS NOT NULL THEN SELECT checksum INTO source_isolation_digest FROM harness.schema_migrations WHERE version=133; END IF;
  IF has_source_isolations IS DISTINCT FROM (source_isolation_digest IS NOT NULL)
    THEN RAISE EXCEPTION 'Physical isolation authority and migration 133 disagree'; END IF;`
const rebuildTables=['operations','reconfiguration','accounts','nodes','runtimes','decisions','execution_holds','data_bindings','binding_requests',
  'execution_requests','execution_reviews','execution_approvals','execution_item_approvals'].map(name=>'governance_rebuild_'+name)
const rebuildInspect=`IF to_regclass('harness.schema_migrations') IS NOT NULL THEN SELECT checksum INTO rebuild_checksum FROM harness.schema_migrations WHERE version=135; END IF;
  has_rebuild:=to_regclass('harness.governance_rebuild_operations') IS NOT NULL;
  IF has_rebuild IS DISTINCT FROM (rebuild_checksum IS NOT NULL) ${rebuildTables.slice(1).map(name=>`OR has_rebuild IS DISTINCT FROM (to_regclass('harness.${name}') IS NOT NULL)`).join(' ')}
  THEN RAISE EXCEPTION 'Governance rebuilding schema and migration 135 disagree'; END IF;`
const rebuildPrefix=`CREATE TEMP TABLE hgw_governance_rebuild_version(present boolean,checksum text) ON COMMIT DROP;
DO $$ DECLARE has_rebuild boolean;rebuild_checksum text;BEGIN
  ${rebuildInspect}
  INSERT INTO hgw_governance_rebuild_version VALUES(has_rebuild,rebuild_checksum);
  IF has_rebuild THEN ${rebuildTables.map((name,index)=>`LOCK TABLE harness.${name} IN SHARE ROW EXCLUSIVE MODE;
    CREATE TEMP TABLE hgw_governance_rebuild_${index} ON COMMIT DROP AS TABLE harness.${name};`).join('\n')} END IF;
END $$;`
const rebuildSuffix=`DO $$ DECLARE has_rebuild boolean;rebuild_checksum text;BEGIN
  ${rebuildInspect}
  IF NOT EXISTS(SELECT FROM hgw_governance_rebuild_version v WHERE v.present=has_rebuild AND v.checksum IS NOT DISTINCT FROM rebuild_checksum)
  THEN RAISE EXCEPTION 'Governance rebuilding version differs from destination'; END IF;
  IF has_rebuild THEN ${rebuildTables.map((name,index)=>`IF EXISTS(SELECT FROM ((TABLE harness.${name} EXCEPT TABLE hgw_governance_rebuild_${index})
    UNION ALL(TABLE hgw_governance_rebuild_${index} EXCEPT TABLE harness.${name})) mismatch)
    THEN RAISE EXCEPTION 'Restore would change governance rebuilding authority'; END IF;`).join('\n')} END IF;
END $$;`
export const TAKEOVER_RESTORE_PREFIX = `${PERSONAL_RECOVERY_RESTORE_PREFIX}
${rebuildPrefix}

CREATE TEMP TABLE hgw_takeover_version(installed boolean,checksum text,approvals boolean,approval_checksum text,disaster boolean,disaster_checksum text,execution boolean,execution_checksum text,transfers boolean,transfer_checksum text,source_isolations boolean,source_isolation_checksum text) ON COMMIT DROP;
DO $peer$ DECLARE has_ops boolean;digest text;has_additions boolean;extra_digest text;has_disaster boolean;disaster_digest text;has_execution boolean;execution_digest text;has_transfers boolean;transfer_digest text;has_source_isolations boolean;source_isolation_digest text;BEGIN
  ${identify}
  ${additions}
  ${disaster}
  ${execution}
  ${transfers}
  ${sourceIsolations}
  INSERT INTO hgw_takeover_version VALUES(has_ops,digest,has_additions,extra_digest,has_disaster,disaster_digest,has_execution,execution_digest,has_transfers,transfer_digest,has_source_isolations,source_isolation_digest);
  IF has_source_isolations THEN
    LOCK TABLE harness.recovery_source_isolations IN SHARE ROW EXCLUSIVE MODE;
    CREATE TEMP TABLE hgw_source_isolation_saved ON COMMIT DROP AS TABLE harness.recovery_source_isolations;
  END IF;
  IF has_transfers THEN
    LOCK TABLE harness.project_recovery_execution_transfers IN SHARE ROW EXCLUSIVE MODE;
    CREATE TEMP TABLE hgw_transfer_saved ON COMMIT DROP AS TABLE harness.project_recovery_execution_transfers;
  END IF;
  IF has_execution THEN
    ${executionTables.map((table, index) => `LOCK TABLE harness.${table} IN SHARE ROW EXCLUSIVE MODE;
    CREATE TEMP TABLE hgw_execution_saved_${index} ON COMMIT DROP AS TABLE harness.${table};`).join('\n')}
  END IF;
  IF has_disaster THEN
    LOCK TABLE harness.project_recovery_isolations,harness.node_recovery_quarantines,harness.project_recovery_execution_holds IN SHARE ROW EXCLUSIVE MODE;
    CREATE TEMP TABLE hgw_isolation_saved ON COMMIT DROP AS TABLE harness.project_recovery_isolations;
    CREATE TEMP TABLE hgw_quarantine_saved ON COMMIT DROP AS TABLE harness.node_recovery_quarantines;
    CREATE TEMP TABLE hgw_execution_hold_saved ON COMMIT DROP AS TABLE harness.project_recovery_execution_holds;
  END IF;
  IF has_ops THEN
    LOCK TABLE harness.project_recovery_operations IN SHARE ROW EXCLUSIVE MODE;
    CREATE TEMP TABLE hgw_takeover_saved ON COMMIT DROP AS TABLE harness.project_recovery_operations;
  END IF;
  IF has_additions THEN
    LOCK TABLE harness.project_recovery_policy_approvals,harness.project_recovery_cleanups IN SHARE ROW EXCLUSIVE MODE;
    CREATE TEMP TABLE hgw_reapproval_saved ON COMMIT DROP AS TABLE harness.project_recovery_policy_approvals;
    CREATE TEMP TABLE hgw_cleanup_saved ON COMMIT DROP AS TABLE harness.project_recovery_cleanups;
  END IF;
END $peer$;`
export const TAKEOVER_RESTORE_SUFFIX = `${PERSONAL_RECOVERY_RESTORE_SUFFIX}
${rebuildSuffix}

DO $peer$ DECLARE has_ops boolean;digest text;has_additions boolean;extra_digest text;has_disaster boolean;disaster_digest text;has_execution boolean;execution_digest text;has_transfers boolean;transfer_digest text;has_source_isolations boolean;source_isolation_digest text;BEGIN
  ${identify}
  ${additions}
  ${disaster}
  ${execution}
  ${transfers}
  ${sourceIsolations}
  IF NOT EXISTS(SELECT FROM hgw_takeover_version s WHERE s.installed=has_ops AND s.checksum IS NOT DISTINCT FROM digest AND s.approvals=has_additions AND s.approval_checksum IS NOT DISTINCT FROM extra_digest AND s.disaster=has_disaster AND s.disaster_checksum IS NOT DISTINCT FROM disaster_digest AND s.execution=has_execution AND s.execution_checksum IS NOT DISTINCT FROM execution_digest AND s.transfers=has_transfers AND s.transfer_checksum IS NOT DISTINCT FROM transfer_digest AND s.source_isolations=has_source_isolations AND s.source_isolation_checksum IS NOT DISTINCT FROM source_isolation_digest)
    THEN RAISE EXCEPTION 'Project recovery version differs from destination'; END IF;
  IF has_source_isolations THEN
    IF EXISTS(SELECT FROM ((TABLE harness.recovery_source_isolations EXCEPT TABLE hgw_source_isolation_saved)
      UNION ALL (TABLE hgw_source_isolation_saved EXCEPT TABLE harness.recovery_source_isolations)) d)
    THEN RAISE EXCEPTION 'Physical isolation authority differs from destination'; END IF;
  END IF;
  IF has_transfers THEN
    IF EXISTS(SELECT FROM ((TABLE harness.project_recovery_execution_transfers EXCEPT TABLE hgw_transfer_saved)
    UNION ALL (TABLE hgw_transfer_saved EXCEPT TABLE harness.project_recovery_execution_transfers)) d)
    THEN RAISE EXCEPTION 'Execution transfer authority differs from destination'; END IF;
  END IF;
  IF has_execution THEN
    IF ${executionTables.map((table, index) => `EXISTS(SELECT FROM ((TABLE harness.${table} EXCEPT TABLE hgw_execution_saved_${index}) UNION ALL (TABLE hgw_execution_saved_${index} EXCEPT TABLE harness.${table})) d)`).join('\n OR ')}
    THEN RAISE EXCEPTION 'Execution recovery approvals differ from destination'; END IF;
  END IF;
  IF has_ops THEN
    IF EXISTS(SELECT FROM ((TABLE harness.project_recovery_operations EXCEPT TABLE hgw_takeover_saved)
    UNION ALL (TABLE hgw_takeover_saved EXCEPT TABLE harness.project_recovery_operations)) mismatch)
    THEN RAISE EXCEPTION 'Project recovery authority differs from destination'; END IF;
  END IF;
  IF has_additions THEN
    IF EXISTS(SELECT FROM ((TABLE harness.project_recovery_policy_approvals EXCEPT TABLE hgw_reapproval_saved)
      UNION ALL (TABLE hgw_reapproval_saved EXCEPT TABLE harness.project_recovery_policy_approvals)) d)
      OR EXISTS(SELECT FROM ((TABLE harness.project_recovery_cleanups EXCEPT TABLE hgw_cleanup_saved)
      UNION ALL (TABLE hgw_cleanup_saved EXCEPT TABLE harness.project_recovery_cleanups)) d)
    THEN RAISE EXCEPTION 'Project recovery approvals or cleanup receipts differ from destination'; END IF;
  END IF;
  IF has_disaster THEN
    IF EXISTS(SELECT FROM ((TABLE harness.project_recovery_isolations EXCEPT TABLE hgw_isolation_saved) UNION ALL (TABLE hgw_isolation_saved EXCEPT TABLE harness.project_recovery_isolations)) d)
      OR EXISTS(SELECT FROM ((TABLE harness.node_recovery_quarantines EXCEPT TABLE hgw_quarantine_saved) UNION ALL (TABLE hgw_quarantine_saved EXCEPT TABLE harness.node_recovery_quarantines)) d)
      OR EXISTS(SELECT FROM ((TABLE harness.project_recovery_execution_holds EXCEPT TABLE hgw_execution_hold_saved) UNION ALL (TABLE hgw_execution_hold_saved EXCEPT TABLE harness.project_recovery_execution_holds)) d)
    THEN RAISE EXCEPTION 'Disaster isolation or execution review authority differs from destination'; END IF;
  END IF;
END $peer$;`
