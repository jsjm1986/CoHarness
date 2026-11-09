import { PERSONAL_DOCUMENT_HISTORY_PREFIX, PERSONAL_DOCUMENT_HISTORY_SUFFIX } from './personal-document-history-restore.ts'
/** Keep a maintenance restore from relocating a published document root or reinstating withdrawn access. */
const shape = `IF to_regnamespace('harness') IS NULL THEN RAISE EXCEPTION 'Organization schema unavailable'; END IF;
  found_scope := to_regclass('harness.document_scope_placement') IS NOT NULL;
  IF to_regclass('harness.schema_migrations') IS NOT NULL THEN SELECT checksum INTO migration_hash FROM harness.schema_migrations WHERE version=112; END IF;
  IF found_scope IS DISTINCT FROM (migration_hash IS NOT NULL) OR found_scope IS DISTINCT FROM (to_regclass('harness.document_scope_writers') IS NOT NULL) OR found_scope IS DISTINCT FROM (to_regclass('harness.document_transfer_delivery') IS NOT NULL) THEN RAISE EXCEPTION 'Document placement schema and migration 112 disagree'; END IF;`
const authority = `SELECT to_jsonb(p) placement, to_jsonb(v) volume, o.status organization,n.status node,t.enabled,t.primary_node_id,
  a.attachment_state,a.revoked_at,a.credential_hash,u.id account,u.status account_status,u.deleted_at,pj.id project,pj.status project_status,to_jsonb(pj)->>'logical_name_id' current_name_id,
  r.id runtime,r.node_id runtime_node,r.owner_kind,r.owner_id,r.retired_at
  FROM harness.document_scope_placement p LEFT JOIN harness.node_content_volumes v USING(organization_id,node_id,volume_id)
  LEFT JOIN harness.organizations o ON o.id=p.organization_id LEFT JOIN harness.compute_nodes n ON n.organization_id=p.organization_id AND n.id=p.node_id
  LEFT JOIN harness.deployment_topology t ON t.organization_id=p.organization_id
  LEFT JOIN harness.node_agents a ON a.organization_id=p.organization_id AND a.node_id=p.node_id
  LEFT JOIN harness.users u ON p.scope_kind='personal' AND u.organization_id=p.organization_id AND u.id=p.scope_id
  LEFT JOIN harness.projects pj ON p.scope_kind='project' AND pj.organization_id=p.organization_id AND pj.id=p.scope_id
  LEFT JOIN harness.runtime_environments r ON r.organization_id=p.organization_id AND r.id=p.project_runtime_id`
const columns = `SELECT attnum,attname,format_type(atttypid,atttypmod) type FROM pg_attribute
  WHERE attrelid='harness.document_scope_placement'::regclass AND attnum>0 AND NOT attisdropped`

/** Run in the same transaction as the restore before replacing organization SQL. */
export const NODE_DOCUMENTS_RESTORE_PREFIX = PERSONAL_DOCUMENT_HISTORY_PREFIX + `
CREATE TEMP TABLE hgw_document_restore_version(present boolean NOT NULL,digest text) ON COMMIT DROP;
DO $doc$ DECLARE found_scope boolean;migration_hash text; BEGIN
  ${shape}
  INSERT INTO hgw_document_restore_version VALUES(found_scope,migration_hash);
  IF found_scope THEN
    LOCK TABLE harness.document_scope_placement,harness.document_scope_writers,harness.document_transfer_delivery IN SHARE ROW EXCLUSIVE MODE;
    CREATE TEMP TABLE hgw_document_restore_delivery ON COMMIT DROP AS TABLE harness.document_transfer_delivery;
    CREATE TEMP TABLE hgw_document_restore_writers ON COMMIT DROP AS SELECT * FROM harness.document_scope_writers WHERE published;
    CREATE TEMP TABLE hgw_document_restore_owners ON COMMIT DROP AS ${authority};
    CREATE TEMP TABLE hgw_document_restore_columns ON COMMIT DROP AS ${columns};
  END IF;
END $doc$;`

/** Legacy-to-legacy works. Mixed schemas, new or missing bindings and stale principals abort the entire maintenance transaction. */
export const NODE_DOCUMENTS_RESTORE_SUFFIX = `
DO $doc$ DECLARE found_scope boolean;migration_hash text; BEGIN
  ${shape}
  IF NOT EXISTS(SELECT FROM hgw_document_restore_version s WHERE s.present=found_scope AND s.digest IS NOT DISTINCT FROM migration_hash)
    THEN RAISE EXCEPTION 'Restored document placement version differs from destination'; END IF;
  IF found_scope THEN
    IF EXISTS(SELECT FROM ((TABLE harness.document_transfer_delivery EXCEPT TABLE hgw_document_restore_delivery) UNION ALL
      (TABLE hgw_document_restore_delivery EXCEPT TABLE harness.document_transfer_delivery)) diff)
      THEN RAISE EXCEPTION 'Restored document transfer receipts differ from destination'; END IF;
    IF EXISTS(WITH current_flags AS (SELECT * FROM harness.document_scope_writers WHERE published)
      SELECT FROM ((TABLE current_flags EXCEPT TABLE hgw_document_restore_writers) UNION ALL (TABLE hgw_document_restore_writers EXCEPT TABLE current_flags)) diff)
      THEN RAISE EXCEPTION 'Restored document writer ownership differs from destination'; END IF;
    IF EXISTS(WITH current_columns AS (${columns}) SELECT FROM ((TABLE current_columns EXCEPT TABLE hgw_document_restore_columns)
      UNION ALL (TABLE hgw_document_restore_columns EXCEPT TABLE current_columns)) diff)
      THEN RAISE EXCEPTION 'Restored document placement schema differs from destination'; END IF;
    IF EXISTS(WITH current_owners AS (${authority}) SELECT FROM ((TABLE current_owners EXCEPT TABLE hgw_document_restore_owners)
      UNION ALL (TABLE hgw_document_restore_owners EXCEPT TABLE current_owners)) diff)
      THEN RAISE EXCEPTION 'Restored document placement or present owner authority differs from destination'; END IF;
    IF EXISTS(SELECT FROM harness.document_scope_placement p JOIN harness.document_catalog c ON c.organization_id=p.organization_id AND c.node_id=p.node_id
      AND c.scope_kind=p.scope_kind AND coalesce(c.scope_user_id,c.scope_project_id)=p.scope_id)
      OR EXISTS(SELECT FROM harness.document_scope_placement p JOIN harness.document_projection_checkpoints c ON c.organization_id=p.organization_id AND c.node_id=p.node_id
      AND c.scope_kind=p.scope_kind AND coalesce(c.scope_user_id,c.scope_project_id)=p.scope_id) THEN
      IF to_regclass('harness.personal_document_imports') IS NULL THEN RAISE EXCEPTION 'Restored shared document content conflicts with a published local root'; END IF;
      IF EXISTS(SELECT FROM harness.document_scope_placement p WHERE NOT harness.historical_personal_document_proven(
        p.organization_id,p.node_id,p.scope_kind,p.scope_id,p.root_id,p.volume_id)
        AND (EXISTS(SELECT FROM harness.document_catalog c WHERE c.organization_id=p.organization_id AND c.node_id=p.node_id
          AND c.scope_kind=p.scope_kind AND coalesce(c.scope_user_id,c.scope_project_id)=p.scope_id)
        OR EXISTS(SELECT FROM harness.document_projection_checkpoints c WHERE c.organization_id=p.organization_id AND c.node_id=p.node_id
          AND c.scope_kind=p.scope_kind AND coalesce(c.scope_user_id,c.scope_project_id)=p.scope_id))) THEN
        RAISE EXCEPTION 'Restored shared document content differs from its independently certified retained predecessor'; END IF;
    END IF;
  END IF;
END $doc$;` + PERSONAL_DOCUMENT_HISTORY_SUFFIX
