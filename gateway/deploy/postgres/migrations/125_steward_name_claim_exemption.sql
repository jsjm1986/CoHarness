-- Steward projects carry system-generated reserved names bound to their node
-- (kind='steward' + steward_node_id). Each node seeds its steward without a
-- browser actor, so no primary-signed name proof can exist at insert time;
-- requiring claims would make steward seeding impossible under an organization
-- name policy. Exempt the kind from the insert/update-time coverage check.
-- Activation coverage is unaffected: reindexNames claims steward rows like any
-- other project before activateProjectNameKey admits a pending key.
CREATE OR REPLACE FUNCTION harness.require_project_name_claims() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE policy harness.project_name_policies%ROWTYPE; current_revision bigint;
BEGIN
  IF NEW.kind='steward' THEN RETURN NULL; END IF;
  SELECT * INTO policy FROM harness.project_name_policies WHERE organization_id=NEW.organization_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT logical_name_revision INTO current_revision FROM harness.projects WHERE id=NEW.id AND organization_id=NEW.organization_id AND status='active';
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF policy.normalization IS DISTINCT FROM harness.project_name_normalization() OR EXISTS(
    SELECT FROM unnest(array_remove(ARRAY[policy.active_key,policy.next_key],NULL)) k WHERE NOT EXISTS (
      SELECT FROM harness.project_name_claims c WHERE c.organization_id=NEW.organization_id AND c.project_id=NEW.id AND c.key_id=k AND c.name_revision=current_revision)
  ) THEN RAISE EXCEPTION 'current organization project name proof is required' USING ERRCODE='23514',CONSTRAINT='project_name_policy_coverage'; END IF;
  RETURN NULL;
END $$;
