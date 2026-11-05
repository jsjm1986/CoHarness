import { SOURCE_RETIREMENT_RESTORE_PREFIX, SOURCE_RETIREMENT_RESTORE_SUFFIX } from './node-content-source-retirement-restore.ts'
/** A maintenance restore cannot elect a writer or roll a published content volume back to an earlier epoch. */
import { TAKEOVER_RESTORE_PREFIX, TAKEOVER_RESTORE_SUFFIX } from './peer-backup-takeover-restore-guard.ts'
import { PROJECT_NAME_RESTORE_PREFIX, PROJECT_NAME_RESTORE_SUFFIX } from './node-content-project-name-restore.ts'
import { NODE_DOCUMENTS_RESTORE_PREFIX, NODE_DOCUMENTS_RESTORE_SUFFIX } from './node-documents-restore-guard.ts'
import { PEER_BACKUP_RESTORE_PREFIX, PEER_BACKUP_RESTORE_SUFFIX } from './peer-backup-restore-guard.ts'

const readPlacement = `
  IF to_regclass('harness.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'A content placement restore requires a recognized governance schema';
  END IF;
  SELECT checksum INTO version_hash FROM harness.schema_migrations WHERE version=108;
  IF (to_regclass('harness.node_content_volumes') IS NOT NULL) IS DISTINCT FROM (version_hash IS NOT NULL)
    OR (to_regclass('harness.project_content_placement') IS NOT NULL) IS DISTINCT FROM (version_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'The content placement schema is incomplete';
  END IF;`

const placementRows = `
  SELECT 'volume' kind,to_jsonb(v) row_data FROM harness.node_content_volumes v
  UNION ALL SELECT 'space',to_jsonb(s) FROM harness.project_content_placement s
  UNION ALL SELECT 'runtime',jsonb_build_array(e.organization_id,e.id,e.owner_kind,e.owner_id,e.node_id,e.retired_at)
    FROM harness.runtime_environments e JOIN harness.project_content_placement p ON p.organization_id=e.organization_id AND p.runtime_id=e.id
  UNION ALL SELECT 'writer',jsonb_build_array(i.organization_id,i.runtime_id,i.assigned_node_id,i.generation,i.provisioning_state)
    FROM harness.instances i JOIN harness.project_content_placement p ON p.organization_id=i.organization_id AND p.runtime_id=i.runtime_id
  UNION ALL SELECT 'node',jsonb_build_array(n.organization_id,n.id,n.status)
    FROM harness.compute_nodes n WHERE EXISTS (SELECT 1 FROM harness.node_content_volumes v
      WHERE v.organization_id=n.organization_id AND v.node_id=n.id)
  UNION ALL SELECT 'project',jsonb_build_array(p.organization_id,p.id,p.status)
    FROM harness.projects p JOIN harness.project_content_placement b ON b.organization_id=p.organization_id AND b.project_id=p.id`

const inspectDirectory = `
  SELECT checksum INTO directory_hash FROM harness.schema_migrations WHERE version=110;
  IF (to_regclass('harness.personal_directory_placement') IS NOT NULL) IS DISTINCT FROM (directory_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'Personal directory schema and migration 110 disagree';
  END IF;`

const directoryRows = `SELECT jsonb_build_array(p.organization_id,p.node_id,p.owner_id,p.runtime_id,e.owner_kind,e.owner_id,e.node_id,e.retired_at,n.status)
  FROM harness.personal_directory_placement p JOIN harness.runtime_environments e ON e.id=p.runtime_id AND e.organization_id=p.organization_id
  JOIN harness.compute_nodes n ON n.id=p.node_id AND n.organization_id=p.organization_id`

/** Snapshot the destination's published assignments under the maintenance transaction's writer exclusion. */
export const NODE_CONTENT_RESTORE_PREFIX = `
CREATE TEMP TABLE hgw_content_restore_schema(checksum text,directory_checksum text) ON COMMIT DROP;
CREATE TEMP TABLE hgw_directory_restore_rows(value jsonb PRIMARY KEY) ON COMMIT DROP;
CREATE TEMP TABLE hgw_content_restore_rows(kind text NOT NULL, row_data jsonb NOT NULL, PRIMARY KEY(kind,row_data)) ON COMMIT DROP;
DO $$ DECLARE version_hash text; directory_hash text; BEGIN
  ${readPlacement}
  ${inspectDirectory}
  INSERT INTO hgw_content_restore_schema VALUES(version_hash,directory_hash);
  IF directory_hash IS NOT NULL THEN
    LOCK TABLE harness.personal_directory_placement IN SHARE ROW EXCLUSIVE MODE;
    INSERT INTO hgw_directory_restore_rows ${directoryRows};
  END IF;
  IF version_hash IS NOT NULL THEN
    LOCK TABLE harness.node_content_volumes,harness.project_content_placement,harness.runtime_environments,harness.instances,harness.compute_nodes,harness.projects IN SHARE ROW EXCLUSIVE MODE;
    INSERT INTO hgw_content_restore_rows ${placementRows};
  END IF;
END $$;
${PEER_BACKUP_RESTORE_PREFIX}
${NODE_DOCUMENTS_RESTORE_PREFIX}
${PROJECT_NAME_RESTORE_PREFIX}
${TAKEOVER_RESTORE_PREFIX}
${SOURCE_RETIREMENT_RESTORE_PREFIX}`

/** Accept only the same volume, project writer and epoch. A different location requires an isolated recovery. */
export const NODE_CONTENT_RESTORE_SUFFIX = `
DO $$ DECLARE version_hash text; saved_hash text; directory_hash text; prior_directory_hash text; BEGIN
  ${readPlacement}
  ${inspectDirectory}
  SELECT checksum,directory_checksum INTO STRICT saved_hash,prior_directory_hash FROM hgw_content_restore_schema;
  IF directory_hash IS DISTINCT FROM prior_directory_hash THEN RAISE EXCEPTION 'Governance restore crosses the personal directory schema version'; END IF;
  IF directory_hash IS NOT NULL THEN
    IF EXISTS (WITH restored(value) AS (${directoryRows}) SELECT 1 FROM restored FULL JOIN hgw_directory_restore_rows saved USING(value)
      WHERE restored.value IS NULL OR saved.value IS NULL)
    THEN RAISE EXCEPTION 'Governance restore would change a personal directory owner'; END IF;
  END IF;
  IF version_hash IS DISTINCT FROM saved_hash THEN RAISE EXCEPTION 'Governance restore crosses the content placement schema version'; END IF;
  IF version_hash IS NOT NULL THEN
    IF EXISTS (
    WITH restored(kind,row_data) AS (${placementRows}) SELECT 1 FROM restored FULL JOIN hgw_content_restore_rows saved USING(kind,row_data)
      WHERE restored.row_data IS NULL OR saved.row_data IS NULL
  ) THEN RAISE EXCEPTION 'Governance restore would change a node content volume or project writer epoch; use isolated recovery'; END IF;
  END IF;
END $$;
${PEER_BACKUP_RESTORE_SUFFIX}
${NODE_DOCUMENTS_RESTORE_SUFFIX}
${PROJECT_NAME_RESTORE_SUFFIX}
${TAKEOVER_RESTORE_SUFFIX}
${SOURCE_RETIREMENT_RESTORE_SUFFIX}
DO $$ BEGIN
  IF to_regclass('harness.project_name_handoffs') IS NOT NULL THEN DELETE FROM harness.project_name_handoffs; END IF;
END $$;`
