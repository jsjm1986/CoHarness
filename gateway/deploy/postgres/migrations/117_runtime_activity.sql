-- Lock an addressed instance and check current authority after contention in one Gateway round trip.
CREATE FUNCTION harness.record_runtime_activity(
  tenant uuid, computer uuid, owner_kind text, public_owner bigint, wanted_runtime uuid,
  activity_ms double precision, wanted_generation bigint, acquire boolean
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  owner_id uuid;
  instance_id uuid;
BEGIN
  IF owner_kind='user' THEN
    SELECT u.id INTO owner_id FROM harness.users u WHERE u.organization_id=tenant AND u.public_id=public_owner;
  ELSIF owner_kind='project' THEN
    SELECT p.id INTO owner_id FROM harness.projects p WHERE p.organization_id=tenant AND p.public_id=public_owner;
  ELSE
    RETURN false;
  END IF;
  IF owner_id IS NULL THEN RETURN false; END IF;
  IF current_setting('statement_timeout')<>'0' THEN
    PERFORM set_config('lock_timeout',current_setting('statement_timeout'),true);
  END IF;

  SELECT i.id INTO instance_id FROM harness.instances i
    WHERE i.organization_id=tenant AND i.assigned_node_id=computer
      AND (CASE WHEN owner_kind='user' THEN i.user_id ELSE i.project_id END)=owner_id
      AND (i.runtime_id=wanted_runtime OR (wanted_runtime IS NULL AND NOT EXISTS(
        SELECT FROM harness.instances sibling WHERE sibling.organization_id=tenant AND sibling.assigned_node_id=computer
          AND (CASE WHEN owner_kind='user' THEN sibling.user_id ELSE sibling.project_id END)=owner_id
          AND sibling.runtime_id<>i.runtime_id)))
    FOR UPDATE OF i;
  IF instance_id IS NULL THEN RETURN false; END IF;

  -- A revocation can commit while the instance lock is held by another connection.
  UPDATE harness.instances i SET last_activity_at=to_timestamp(activity_ms/1000.0),updated_at=now()
    WHERE i.id=instance_id AND i.organization_id=tenant AND i.assigned_node_id=computer
      AND (CASE WHEN owner_kind='user' THEN i.user_id ELSE i.project_id END)=owner_id
      AND (i.runtime_id=wanted_runtime OR (wanted_runtime IS NULL AND NOT EXISTS(
        SELECT FROM harness.instances sibling WHERE sibling.organization_id=tenant AND sibling.assigned_node_id=computer
          AND (CASE WHEN owner_kind='user' THEN sibling.user_id ELSE sibling.project_id END)=owner_id
          AND sibling.runtime_id<>i.runtime_id)))
      AND (NOT acquire OR (
        i.observed_state='ready' AND i.provisioning_state='ready'
        AND (wanted_generation IS NULL OR i.generation=wanted_generation)
        AND harness.runtime_node_execution_allowed(tenant,computer,i.node_connection_id,i.node_connection_epoch)
        AND CASE WHEN owner_kind='user' THEN EXISTS(
          SELECT FROM harness.users u JOIN harness.memberships m ON (m.organization_id,m.user_id)=(u.organization_id,u.id)
          WHERE u.organization_id=tenant AND u.id=owner_id AND u.public_id=public_owner AND u.status='active'
            AND u.deleted_at IS NULL AND m.status='active' AND harness.computer_use_allowed(tenant,u.id,computer))
          ELSE EXISTS(SELECT FROM harness.projects p WHERE p.organization_id=tenant AND p.id=owner_id
            AND p.public_id=public_owner AND p.status='active') END
      ));
  RETURN FOUND;
END
$$;
