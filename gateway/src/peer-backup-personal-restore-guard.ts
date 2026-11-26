/** A maintenance restore cannot roll back personal placement or its approved recovery execution state. */
const tables = ['personal_recovery_operations','personal_recovery_document_receipts','personal_recovery_policy_approvals',
  'personal_recovery_execution_holds','personal_recovery_execution_requests','personal_recovery_execution_reviews',
  'personal_recovery_execution_approvals','personal_recovery_execution_item_approvals'] as const
const inspect = `IF to_regclass('harness.schema_migrations') IS NOT NULL THEN SELECT checksum INTO checksum_value FROM harness.schema_migrations WHERE version=134; END IF;
  has_personal:=to_regclass('harness.personal_recovery_operations') IS NOT NULL;
  IF has_personal IS DISTINCT FROM (checksum_value IS NOT NULL) ${tables.slice(1).map(name=>`OR has_personal IS DISTINCT FROM (to_regclass('harness.${name}') IS NOT NULL)`).join(' ')}
  THEN RAISE EXCEPTION 'Personal recovery schema and migration 134 disagree'; END IF;`
/** Preserve destination personal takeover evidence before any source schema replacement. */
export const PERSONAL_RECOVERY_RESTORE_PREFIX = `
CREATE TEMP TABLE hgw_personal_recovery_version(present boolean,checksum text) ON COMMIT DROP;
DO $$ DECLARE has_personal boolean;checksum_value text;BEGIN
  ${inspect}
  INSERT INTO hgw_personal_recovery_version VALUES(has_personal,checksum_value);
  IF has_personal THEN
    ${tables.map((name,index)=>`LOCK TABLE harness.${name} IN SHARE ROW EXCLUSIVE MODE;
    CREATE TEMP TABLE hgw_personal_recovery_${index} ON COMMIT DROP AS TABLE harness.${name};`).join('\n')}
  END IF;
END $$;`
/** Reject an older dump or any difference in immutable or active personal recovery authority. */
export const PERSONAL_RECOVERY_RESTORE_SUFFIX = `
DO $$ DECLARE has_personal boolean;checksum_value text;BEGIN
  ${inspect}
  IF NOT EXISTS(SELECT FROM hgw_personal_recovery_version v WHERE v.present=has_personal AND v.checksum IS NOT DISTINCT FROM checksum_value)
  THEN RAISE EXCEPTION 'Personal recovery migration differs from the destination'; END IF;
  IF has_personal THEN
    ${tables.map((name,index)=>`IF EXISTS(SELECT FROM (SELECT to_jsonb(t) row FROM harness.${name} t) restored
      FULL JOIN (SELECT to_jsonb(t) row FROM hgw_personal_recovery_${index} t) saved USING(row) WHERE restored.row IS NULL OR saved.row IS NULL)
    THEN RAISE EXCEPTION 'Restore would change personal recovery authority'; END IF;`).join('\n')}
  END IF;
END $$;`
