/** Maintenance cannot restore an older writer or erase the operator's irreversible takeover evidence. */
const identify = `has_ops:=to_regclass('harness.project_recovery_operations') IS NOT NULL;
  IF to_regclass('harness.schema_migrations') IS NOT NULL THEN SELECT checksum INTO digest FROM harness.schema_migrations WHERE version=115; END IF;
  IF has_ops IS DISTINCT FROM (digest IS NOT NULL) THEN RAISE EXCEPTION 'Project recovery schema and migration 115 disagree'; END IF;`
const additions = `has_additions:=to_regclass('harness.project_recovery_policy_approvals') IS NOT NULL;
  IF to_regclass('harness.schema_migrations') IS NOT NULL THEN SELECT checksum INTO extra_digest FROM harness.schema_migrations WHERE version=119; END IF;
  IF has_additions IS DISTINCT FROM (extra_digest IS NOT NULL)
    OR has_additions IS DISTINCT FROM (to_regclass('harness.project_recovery_cleanups') IS NOT NULL)
    THEN RAISE EXCEPTION 'Project recovery approvals and migration 119 disagree'; END IF;`
export const TAKEOVER_RESTORE_PREFIX = `
CREATE TEMP TABLE hgw_takeover_version(installed boolean,checksum text,approvals boolean,approval_checksum text) ON COMMIT DROP;
DO $peer$ DECLARE has_ops boolean;digest text;has_additions boolean;extra_digest text;BEGIN
  ${identify}
  ${additions}
  INSERT INTO hgw_takeover_version VALUES(has_ops,digest,has_additions,extra_digest);
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
export const TAKEOVER_RESTORE_SUFFIX = `
DO $peer$ DECLARE has_ops boolean;digest text;has_additions boolean;extra_digest text;BEGIN
  ${identify}
  ${additions}
  IF NOT EXISTS(SELECT FROM hgw_takeover_version s WHERE s.installed=has_ops AND s.checksum IS NOT DISTINCT FROM digest AND s.approvals=has_additions AND s.approval_checksum IS NOT DISTINCT FROM extra_digest)
    THEN RAISE EXCEPTION 'Project recovery version differs from destination'; END IF;
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
END $peer$;`
