/** A governance restore cannot discard custody history or substitute another original source or reviewed media inventory. */
const inspect=`IF to_regclass('harness.schema_migrations') IS NOT NULL THEN SELECT checksum INTO signature FROM harness.schema_migrations WHERE version=116; END IF;
  SELECT count(*) INTO present FROM (VALUES('harness.project_source_retirement_reviews'),('harness.project_source_retirement_evidence')) x(name) WHERE to_regclass(name) IS NOT NULL;
  IF present NOT IN (0,2) OR (present=2) IS DISTINCT FROM (signature IS NOT NULL) THEN RAISE EXCEPTION 'Source retirement storage is incomplete'; END IF;`
const rows=`SELECT 'source' kind,jsonb_build_array(j.id,j.organization_id,j.project_id,j.runtime_id,j.source_cluster_id,j.source_database_oid) data FROM harness.project_content_copy_jobs j
  UNION ALL SELECT 'review',to_jsonb(r) FROM harness.project_source_retirement_reviews r
  UNION ALL SELECT 'evidence',to_jsonb(e) FROM harness.project_source_retirement_evidence e`
/** Retain the recognized schema, original cluster identifiers and scoped custody evidence before a restore. */
export const SOURCE_RETIREMENT_RESTORE_PREFIX=`CREATE TEMP TABLE hgw_retirement_restore_version(checksum text) ON COMMIT DROP;
CREATE TEMP TABLE hgw_retirement_restore_evidence(kind text,data jsonb,PRIMARY KEY(kind,data)) ON COMMIT DROP;
DO $$ DECLARE signature text;present int; BEGIN ${inspect}
  INSERT INTO hgw_retirement_restore_version VALUES(signature);IF signature IS NOT NULL THEN INSERT INTO hgw_retirement_restore_evidence ${rows}; END IF; END $$;`
/** Refuse a rollback or substitution of the retained source and its retirement evidence. */
export const SOURCE_RETIREMENT_RESTORE_SUFFIX=`DO $$ DECLARE signature text;present int; BEGIN ${inspect}
  IF signature IS DISTINCT FROM (SELECT checksum FROM hgw_retirement_restore_version) THEN RAISE EXCEPTION 'Source retirement schema differs from the destination'; END IF;
  IF signature IS NOT NULL AND EXISTS(WITH restored(kind,data) AS (${rows}) SELECT FROM restored FULL JOIN hgw_retirement_restore_evidence saved USING(kind,data)
    WHERE restored.data IS NULL OR saved.data IS NULL) THEN RAISE EXCEPTION 'Restore changes an original source or its custody evidence'; END IF; END $$;`
