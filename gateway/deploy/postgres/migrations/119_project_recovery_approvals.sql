CREATE TABLE harness.project_recovery_policy_approvals (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL, operation_id uuid NOT NULL REFERENCES harness.project_recovery_operations(id),
  policy_revision integer NOT NULL CHECK(policy_revision>0), approved_by uuid NOT NULL, approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(approved_by,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE INDEX recovery_policy_approval_head ON harness.project_recovery_policy_approvals(operation_id,sequence DESC);
CREATE TABLE harness.project_recovery_cleanups (
  operation_id uuid PRIMARY KEY REFERENCES harness.project_recovery_operations(id), organization_id uuid NOT NULL,
  node_id uuid NOT NULL, volume_id uuid NOT NULL, completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(organization_id,node_id,volume_id) REFERENCES harness.node_content_volumes(organization_id,node_id,volume_id)
);
CREATE FUNCTION harness.keep_recovery_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Recovery approvals and cleanup acknowledgements are immutable'; END $$;
CREATE TRIGGER keep_recovery_policy_approvals BEFORE UPDATE OR DELETE ON harness.project_recovery_policy_approvals
  FOR EACH ROW EXECUTE FUNCTION harness.keep_recovery_receipt();
CREATE TRIGGER keep_recovery_cleanups BEFORE UPDATE OR DELETE ON harness.project_recovery_cleanups
  FOR EACH ROW EXECUTE FUNCTION harness.keep_recovery_receipt();
CREATE FUNCTION harness.recovery_policy_revision(operation uuid,initial_revision integer)
RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT coalesce((SELECT a.policy_revision FROM harness.project_recovery_policy_approvals a
    WHERE a.operation_id=operation ORDER BY a.sequence DESC LIMIT 1),initial_revision)
$$;
CREATE FUNCTION harness.guard_recovery_policy_edit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.enabled AND (NEW.tier,NEW.quota_bytes) IS DISTINCT FROM (OLD.tier,OLD.quota_bytes)
    AND EXISTS(SELECT FROM harness.project_recovery_operations r WHERE r.organization_id=OLD.organization_id AND r.policy_id=OLD.id
      AND r.phase<>'cancelled' AND r.target_activated_at IS NULL)
  THEN RAISE EXCEPTION 'A project recovery is using this policy' USING ERRCODE='55006',CONSTRAINT='recovery_policy_busy'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_recovery_policy_edit BEFORE UPDATE ON harness.peer_backup_policies
  FOR EACH ROW EXECUTE FUNCTION harness.guard_recovery_policy_edit();
CREATE FUNCTION harness.recovery_retirement_actor(operation uuid,original uuid,granted_at timestamptz)
RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN original IS NULL THEN NULL ELSE coalesce((SELECT a.approved_by FROM harness.project_recovery_policy_approvals a
    WHERE a.operation_id=operation AND a.approved_at>=granted_at ORDER BY a.sequence DESC LIMIT 1),original) END
$$;
CREATE FUNCTION harness.bind_recovery_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='project_recovery_policy_approvals' THEN
    IF NOT EXISTS(SELECT FROM harness.project_recovery_operations r JOIN harness.peer_backup_policies p ON p.id=r.policy_id
      JOIN harness.memberships m ON m.organization_id=r.organization_id AND m.user_id=NEW.approved_by AND m.role='admin' AND m.status='active'
      JOIN harness.users u ON u.organization_id=m.organization_id AND u.id=m.user_id AND u.status='active' AND u.deleted_at IS NULL
      WHERE r.id=NEW.operation_id AND r.organization_id=NEW.organization_id AND r.phase<>'cancelled' AND r.target_activated_at IS NULL
        AND p.organization_id=r.organization_id AND p.revision=NEW.policy_revision AND p.enabled)
    THEN RAISE EXCEPTION 'Current recovery revision and administrator are required'; END IF;
  ELSE
    IF NOT EXISTS(SELECT FROM harness.project_recovery_operations r WHERE r.id=NEW.operation_id AND r.organization_id=NEW.organization_id
      AND r.phase='cancelled' AND (r.target_node_id,r.target_volume_id)=(NEW.node_id,NEW.volume_id))
    THEN RAISE EXCEPTION 'Only the cancelled replacement can acknowledge cleanup'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bind_recovery_policy_approvals BEFORE INSERT ON harness.project_recovery_policy_approvals
  FOR EACH ROW EXECUTE FUNCTION harness.bind_recovery_receipt();
CREATE TRIGGER bind_recovery_cleanups BEFORE INSERT ON harness.project_recovery_cleanups
  FOR EACH ROW EXECUTE FUNCTION harness.bind_recovery_receipt();
