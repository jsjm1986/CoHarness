CREATE OR REPLACE FUNCTION harness.guard_recovery_policy_edit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (NEW.tier,NEW.quota_bytes) IS DISTINCT FROM (OLD.tier,OLD.quota_bytes)
    AND EXISTS(SELECT FROM harness.project_recovery_operations r WHERE r.organization_id=OLD.organization_id AND r.policy_id=OLD.id
      AND r.phase<>'cancelled' AND r.target_activated_at IS NULL)
  THEN RAISE EXCEPTION 'A project recovery is using this policy' USING ERRCODE='55006',CONSTRAINT='recovery_policy_busy'; END IF;
  RETURN NEW;
END $$;
