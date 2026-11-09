/** A maintenance restore cannot change an approved account's retired-source fingerprint or borrow its current computer entitlement. */
const version = `present:=to_regclass('harness.personal_document_imports') IS NOT NULL;
  IF to_regclass('harness.schema_migrations') IS NOT NULL THEN SELECT checksum INTO result FROM harness.schema_migrations WHERE version=118; END IF;
  IF present IS DISTINCT FROM (result IS NOT NULL) OR present IS DISTINCT FROM(to_regclass('harness.legacy_document_catalog') IS NOT NULL)
    OR present IS DISTINCT FROM(to_regclass('harness.legacy_document_checkpoints') IS NOT NULL) THEN RAISE EXCEPTION 'Personal document migration version is incomplete'; END IF;`
const owners = `SELECT row_to_json(r)::text receipt,harness.computer_use_allowed(r.organization_id,r.user_id,r.node_id) allowed,
  u.status owner_status,u.deleted_at,a.status approver_status,a.deleted_at approver_deleted,m.role approver_role,m.status approver_membership,
  harness.personal_document_source_digest(r.organization_id,r.node_id,r.user_id) current_digest
  FROM harness.personal_document_imports r LEFT JOIN harness.users u ON r.organization_id=u.organization_id AND r.user_id=u.id
  LEFT JOIN harness.users a ON a.organization_id=r.organization_id AND a.id=r.actor_id
  LEFT JOIN harness.memberships m ON m.user_id=a.id AND m.organization_id=r.organization_id`
export const PERSONAL_DOCUMENT_HISTORY_PREFIX = `
CREATE TEMP TABLE hgw_personal_doc_schema(installed boolean,checksum text) ON COMMIT DROP;
DO $history$ DECLARE present boolean;result text; BEGIN
  ${version}
  INSERT INTO hgw_personal_doc_schema VALUES(present,result);
  IF present THEN
    LOCK TABLE harness.personal_document_imports IN SHARE ROW EXCLUSIVE MODE;
    CREATE TEMP TABLE hgw_personal_doc_owners ON COMMIT DROP AS ${owners};
  END IF;
END $history$;`
export const PERSONAL_DOCUMENT_HISTORY_SUFFIX = `
DO $history$ DECLARE present boolean;result text; BEGIN
  ${version}
  IF NOT EXISTS(SELECT FROM hgw_personal_doc_schema s WHERE s.installed IS NOT DISTINCT FROM present AND s.checksum IS NOT DISTINCT FROM result) THEN
    RAISE EXCEPTION 'Restored personal document schema differs from destination'; END IF;
  IF present THEN
    IF EXISTS(WITH retained AS (${owners}) SELECT FROM ((TABLE retained EXCEPT TABLE hgw_personal_doc_owners) UNION ALL
      (TABLE hgw_personal_doc_owners EXCEPT TABLE retained)) changed) THEN RAISE EXCEPTION 'Restored personal document predecessor or authority differs from destination'; END IF;
  END IF;
END $history$;`
