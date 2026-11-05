/** A governance restore must retain project name keys, reserved digests and the selected node name version. */
const inspectNames=`
  IF to_regclass('harness.schema_migrations') IS NOT NULL THEN
    SELECT checksum INTO signature FROM harness.schema_migrations WHERE version=111;
  END IF;
  SELECT count(*) INTO present FROM (VALUES('harness.project_name_keys'),('harness.project_name_policies'),('harness.project_name_claims')) t(tab)
    WHERE to_regclass(t.tab) IS NOT NULL;
  IF present NOT IN(0,3) OR (present=3) IS DISTINCT FROM (signature IS NOT NULL) THEN RAISE EXCEPTION 'Project name policy schema is incomplete'; END IF;`
const names=`
  SELECT 'key' kind,to_jsonb(k) data FROM harness.project_name_keys k
  UNION ALL SELECT 'policy',to_jsonb(p) FROM harness.project_name_policies p
  UNION ALL SELECT 'reservation',to_jsonb(c) FROM harness.project_name_claims c
  UNION ALL SELECT 'selection',jsonb_build_array(p.organization_id,p.id,p.status,p.logical_name_revision,p.logical_name_id) FROM harness.projects p
    WHERE EXISTS(SELECT FROM harness.project_name_policies policy WHERE policy.organization_id=p.organization_id)
       OR EXISTS(SELECT FROM harness.project_content_placement b WHERE b.organization_id=p.organization_id AND b.project_id=p.id)`

/** Capture destination name governance before import in the existing maintenance transaction. */
export const PROJECT_NAME_RESTORE_PREFIX=`
CREATE TEMP TABLE hgw_project_name_schema(checksum text) ON COMMIT DROP;
CREATE TEMP TABLE hgw_project_name_state(kind text NOT NULL,data jsonb NOT NULL,PRIMARY KEY(kind,data)) ON COMMIT DROP;
DO $$ DECLARE signature text;present int; BEGIN
  ${inspectNames}
  INSERT INTO hgw_project_name_schema VALUES(signature);
  IF signature IS NOT NULL THEN
    LOCK TABLE harness.projects,harness.project_name_keys,harness.project_name_policies,harness.project_name_claims IN SHARE ROW EXCLUSIVE MODE;
    INSERT INTO hgw_project_name_state ${names};
  END IF;
END $$;`

/** Refuse a backup that would change uniqueness enforcement or select a different node-owned project name. */
export const PROJECT_NAME_RESTORE_SUFFIX=`
DO $$ DECLARE signature text;present int; BEGIN
  ${inspectNames}
  IF signature IS DISTINCT FROM (SELECT checksum FROM hgw_project_name_schema)
    THEN RAISE EXCEPTION 'Project name migration differs from the destination'; END IF;
  IF signature IS NOT NULL AND EXISTS(
    WITH restored(kind,data) AS (${names}) SELECT FROM restored FULL JOIN hgw_project_name_state saved USING(kind,data)
      WHERE saved.data IS NULL OR restored.data IS NULL
  ) THEN RAISE EXCEPTION 'Restore would change project name keys, rotation, reservations or selected name versions'; END IF;
END $$;`
