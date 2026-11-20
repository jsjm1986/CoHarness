ALTER TABLE harness.peer_backup_policies
  ADD COLUMN capture_stopped_at timestamptz,
  ADD COLUMN retirement_point_id uuid,
  ADD COLUMN retirement_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN receiver_capacity jsonb,
  ADD COLUMN receiver_capacity_valid_until timestamptz,
  ADD CONSTRAINT peer_backup_retirement_consistent CHECK(
    (retirement_point_id IS NULL OR NOT enabled)
    AND (retired_at IS NULL OR (retirement_point_id IS NOT NULL AND NOT retirement_pending))
    AND (NOT retirement_pending OR retirement_point_id IS NOT NULL)
  );

DROP INDEX harness.peer_backup_one_destination;
CREATE UNIQUE INDEX peer_backup_one_destination ON harness.peer_backup_policies(organization_id,scope_kind,scope_id)
  WHERE enabled AND capture_stopped_at IS NULL;
CREATE INDEX peer_backup_receiver_policies ON harness.peer_backup_policies(organization_id,target_node_id,id) WHERE retired_at IS NULL;
CREATE INDEX peer_backup_retirement_witness ON harness.peer_backup_policies(organization_id,retirement_point_id) WHERE retirement_pending;

-- An older Gateway may still attempt policy edits and schedule captures during rollout.
CREATE FUNCTION harness.guard_peer_backup_repository_seal() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.capture_stopped_at IS NOT NULL AND (NEW.capture_stopped_at,NEW.append_hash) IS DISTINCT FROM
    (OLD.capture_stopped_at,OLD.append_hash)
    THEN RAISE EXCEPTION 'Peer backup repository is sealed' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER peer_backup_repository_seal BEFORE UPDATE OF capture_stopped_at,append_hash
  ON harness.peer_backup_policies FOR EACH ROW EXECUTE FUNCTION harness.guard_peer_backup_repository_seal();

CREATE FUNCTION harness.disallow_sealed_peer_capture() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT FROM harness.peer_backup_policies WHERE id=NEW.policy_id AND capture_stopped_at IS NOT NULL FOR SHARE)
    THEN RETURN NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER peer_backup_capture_only_unsealed BEFORE INSERT ON harness.peer_backup_work
  FOR EACH ROW WHEN (NEW.kind='capture' AND NEW.status IN ('queued','running')) EXECUTE FUNCTION harness.disallow_sealed_peer_capture();
