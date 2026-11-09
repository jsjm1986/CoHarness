/** Destination-owned peer backup approvals and immutable recovery receipts across a maintenance database restore. */
const inspectSchema = `
  SELECT count(*) INTO tables_present FROM (VALUES ('harness.peer_backup_policies'),('harness.peer_backup_work'),('harness.peer_backup_points')) t(name)
    WHERE to_regclass(t.name) IS NOT NULL;
  IF to_regclass('harness.schema_migrations') IS NOT NULL THEN
    SELECT checksum INTO migration_checksum FROM harness.schema_migrations WHERE version=109;
  END IF;
  IF tables_present NOT IN (0,3) OR (tables_present=3) IS DISTINCT FROM (migration_checksum IS NOT NULL) THEN
    RAISE EXCEPTION 'Peer backup schema and migration 109 disagree';
  END IF;`

const nodeCoordinates = `SELECT DISTINCT n.organization_id,n.id,n.status,o.status org_status,t.enabled,t.primary_node_id,
  a.attachment_state,a.credential_hash,a.revoked_at
  FROM hgw_peer_policy_saved p JOIN harness.compute_nodes n ON n.organization_id=p.organization_id
  AND n.id IN (p.source_node_id,p.target_node_id) JOIN harness.organizations o ON o.id=n.organization_id
  LEFT JOIN harness.node_agents a ON a.organization_id=n.organization_id AND a.node_id=n.id
  LEFT JOIN harness.deployment_topology t ON t.organization_id=n.organization_id`
const scopeCoordinates = `SELECT DISTINCT r.organization_id,r.id,r.node_id,r.owner_kind,r.owner_id,r.retired_at,
  u.status user_status,u.deleted_at,pr.status project_status,to_jsonb(pr)->>'logical_name_id' current_name_id
  FROM hgw_peer_policy_saved p JOIN harness.runtime_environments r ON r.organization_id=p.organization_id
  AND ((p.scope_kind='personal' AND r.id=p.scope_id) OR (p.scope_kind='project' AND r.owner_kind='project' AND r.owner_id=p.scope_id))
  LEFT JOIN harness.users u ON r.owner_kind='user' AND u.id=r.owner_id AND u.organization_id=r.organization_id
  LEFT JOIN harness.projects pr ON r.owner_kind='project' AND pr.id=r.owner_id AND pr.organization_id=r.organization_id`

/** Execute in the existing restore transaction before application tables are replaced. */
export const PEER_BACKUP_RESTORE_PREFIX = `
CREATE TEMP TABLE hgw_peer_presence_saved(present boolean NOT NULL,checksum text) ON COMMIT DROP;
DO $peer$ DECLARE tables_present integer; migration_checksum text; BEGIN
${inspectSchema}
INSERT INTO hgw_peer_presence_saved VALUES(tables_present=3,migration_checksum);
IF tables_present=3 THEN
LOCK TABLE harness.peer_backup_policies,harness.peer_backup_work,harness.peer_backup_points IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE hgw_peer_policy_saved ON COMMIT DROP AS TABLE harness.peer_backup_policies;
CREATE TEMP TABLE hgw_peer_work_saved ON COMMIT DROP AS TABLE harness.peer_backup_work;
CREATE TEMP TABLE hgw_peer_point_saved ON COMMIT DROP AS TABLE harness.peer_backup_points;
CREATE TEMP TABLE hgw_peer_node_saved ON COMMIT DROP AS ${nodeCoordinates};
CREATE TEMP TABLE hgw_peer_scope_saved ON COMMIT DROP AS ${scopeCoordinates};
CREATE TEMP TABLE hgw_peer_schema_saved ON COMMIT DROP AS SELECT c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) column_type
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
  WHERE c.relnamespace='harness'::regnamespace AND c.relname IN ('peer_backup_policies','peer_backup_work','peer_backup_points')
  AND a.attnum>0 AND NOT a.attisdropped;
END IF; END $peer$;
`

/** Keep present-day destinations, credential rotations, disabled policies and point history. No earlier claim or rehearsal may publish. */
export const PEER_BACKUP_RESTORE_SUFFIX = `
DO $peer$ DECLARE tables_present integer; migration_checksum text; BEGIN
${inspectSchema}
IF NOT EXISTS(SELECT FROM hgw_peer_presence_saved WHERE present=(tables_present=3) AND checksum IS NOT DISTINCT FROM migration_checksum) THEN
  RAISE EXCEPTION 'Peer backup migration 109 differs from destination';
END IF;
IF tables_present=3 THEN
  IF EXISTS(WITH restored AS (${nodeCoordinates}) SELECT 1 FROM
    ((TABLE restored EXCEPT TABLE hgw_peer_node_saved) UNION ALL (TABLE hgw_peer_node_saved EXCEPT TABLE restored)) delta)
    OR EXISTS(WITH restored AS (${scopeCoordinates}) SELECT 1 FROM
    ((TABLE restored EXCEPT TABLE hgw_peer_scope_saved) UNION ALL (TABLE hgw_peer_scope_saved EXCEPT TABLE restored)) delta)
    THEN RAISE EXCEPTION 'Peer backup node or Runtime authority differs from the current destination'; END IF;
  IF EXISTS(WITH restored AS (SELECT c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) column_type
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid WHERE c.relnamespace='harness'::regnamespace
    AND c.relname IN ('peer_backup_policies','peer_backup_work','peer_backup_points') AND a.attnum>0 AND NOT a.attisdropped)
    SELECT 1 FROM ((TABLE restored EXCEPT TABLE hgw_peer_schema_saved) UNION ALL (TABLE hgw_peer_schema_saved EXCEPT TABLE restored)) mismatch)
    THEN RAISE EXCEPTION 'Peer backup control schema differs from the destination'; END IF;
  IF EXISTS(SELECT FROM hgw_peer_policy_saved p WHERE p.enabled AND (
    NOT EXISTS(SELECT FROM harness.compute_nodes n WHERE n.organization_id=p.organization_id AND n.id=p.source_node_id)
    OR NOT EXISTS(SELECT FROM harness.compute_nodes n WHERE n.organization_id=p.organization_id AND n.id=p.target_node_id)
    OR (p.scope_kind IN ('personal','project') AND NOT EXISTS(SELECT FROM harness.runtime_environments r
      WHERE r.organization_id=p.organization_id AND r.node_id=p.source_node_id AND r.retired_at IS NULL
      AND ((p.scope_kind='personal' AND r.owner_kind='user' AND r.id=p.scope_id)
        OR (p.scope_kind='project' AND r.owner_kind='project' AND r.owner_id=p.scope_id))))
    OR (p.scope_kind='governance' AND p.scope_id<>p.organization_id)))
    THEN RAISE EXCEPTION 'Current peer backup scope cannot be certified against the restored deployment'; END IF;
DELETE FROM harness.peer_backup_points;
DELETE FROM harness.peer_backup_work;
DELETE FROM harness.peer_backup_policies;
UPDATE hgw_peer_policy_saved SET revision=revision+1,updated_at=clock_timestamp();
UPDATE hgw_peer_work_saved SET status='failed',phase='failed',error_code='peer-backup/recovery-fenced',finished_at=clock_timestamp()
  WHERE status IN ('queued','running');
UPDATE hgw_peer_work_saved SET claim=NULL,lease_expires_at=NULL;
INSERT INTO harness.peer_backup_policies SELECT * FROM hgw_peer_policy_saved;
INSERT INTO harness.peer_backup_points SELECT * FROM hgw_peer_point_saved;
INSERT INTO harness.peer_backup_work SELECT * FROM hgw_peer_work_saved;
END IF; END $peer$;
`
