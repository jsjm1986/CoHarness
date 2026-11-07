-- The caller retains the transaction through ownership checks and commit.
CREATE FUNCTION harness.lock_node_resources(tenant uuid, computer uuid, initial_limits jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  current_limits jsonb;
  expired_count bigint;
BEGIN
  INSERT INTO harness.node_resource_state(organization_id,node_id,limits)
    VALUES(tenant,computer,initial_limits) ON CONFLICT DO NOTHING;
  SELECT limits INTO STRICT current_limits FROM harness.node_resource_state
    WHERE organization_id=tenant AND node_id=computer FOR UPDATE;
  WITH expired AS (
    DELETE FROM harness.node_resource_requests WHERE organization_id=tenant AND node_id=computer
      AND state='queued' AND deadline<=clock_timestamp() RETURNING sequence
  ) SELECT count(*) INTO expired_count FROM expired;
  IF expired_count>0 THEN
    UPDATE harness.node_resource_state SET timed_out=timed_out+expired_count
      WHERE organization_id=tenant AND node_id=computer;
  END IF;
  RETURN current_limits;
END;
$$;

-- A node-row lock serializes registration, pressure, cancellation and scheduling.
CREATE FUNCTION harness.schedule_node_resources(tenant uuid, computer uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  next_request harness.node_resource_requests%ROWTYPE;
  changed bigint;
  next_position bigint;
  waiting_ms double precision;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM harness.node_resource_state
    WHERE organization_id=tenant AND node_id=computer FOR UPDATE) THEN
    RAISE EXCEPTION 'Resource node is not initialized';
  END IF;
  WITH stale AS (
    DELETE FROM harness.node_resource_requests request
      WHERE request.organization_id=tenant AND request.node_id=computer
      AND request.state='queued' AND request.runtime_kind IN ('user','project') AND NOT EXISTS(
        SELECT 1 FROM harness.instances i
        LEFT JOIN harness.users u ON u.id=i.user_id LEFT JOIN harness.projects p ON p.id=i.project_id
        JOIN harness.node_resource_runtimes runtime ON runtime.organization_id=request.organization_id
          AND runtime.node_id=request.node_id AND runtime.runtime_kind=request.runtime_kind
          AND runtime.runtime_public_id=request.runtime_public_id AND runtime.generation=request.generation
          AND runtime.runtime_id=i.runtime_id
        WHERE i.organization_id=request.organization_id AND i.assigned_node_id=request.node_id
          AND CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END=request.runtime_kind
          AND COALESCE(u.public_id,p.public_id)=request.runtime_public_id AND i.generation=request.generation
          AND i.desired_state='running' AND i.observed_state IN ('starting','ready')
          AND harness.runtime_node_execution_allowed(i.organization_id,i.assigned_node_id,
            i.node_connection_id,i.node_connection_epoch)) RETURNING sequence
  ) SELECT count(*) INTO changed FROM stale;
  IF changed>0 THEN
    UPDATE harness.node_resource_state SET cancelled=cancelled+changed
      WHERE organization_id=tenant AND node_id=computer;
  END IF;
  IF EXISTS(SELECT 1 FROM harness.instances i
    LEFT JOIN harness.users u ON u.id=i.user_id LEFT JOIN harness.projects p ON p.id=i.project_id
    WHERE i.organization_id=tenant AND i.assigned_node_id=computer
      AND i.observed_state IN ('ready','starting','stopping')
      AND NOT(i.observed_state='starting' AND i.allocation_state IN ('not-started','waiting'))
      AND NOT EXISTS(SELECT 1 FROM harness.node_resource_runtimes runtime
        WHERE runtime.organization_id=i.organization_id AND runtime.node_id=i.assigned_node_id
          AND runtime.runtime_kind=CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END
          AND runtime.runtime_public_id=COALESCE(u.public_id,p.public_id)
          AND runtime.generation=i.generation AND runtime.runtime_id=i.runtime_id)) THEN
    RETURN;
  END IF;
  LOOP
    IF NOT EXISTS(SELECT 1 FROM harness.node_resource_state WHERE organization_id=tenant AND node_id=computer
      AND credits>0 AND valid_until>clock_timestamp() AND harness.node_execution_available(tenant,computer)) THEN
      RETURN;
    END IF;
    SELECT * INTO next_request FROM harness.node_resource_requests
      WHERE organization_id=tenant AND node_id=computer AND state='queued'
      ORDER BY user_turn,project_turn,sequence LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    waiting_ms:=GREATEST(0,EXTRACT(EPOCH FROM clock_timestamp()-next_request.created_at)*1000);
    UPDATE harness.node_resource_state SET credits=credits-1,admitted=admitted+1,
      wait_ms_total=wait_ms_total+waiting_ms,wait_ms_max=GREATEST(wait_ms_max,waiting_ms)
      WHERE organization_id=tenant AND node_id=computer AND credits>0 AND valid_until>clock_timestamp()
      AND harness.node_execution_available(tenant,computer)
      AND (next_request.runtime_kind='gateway' OR EXISTS(
        SELECT 1 FROM harness.instances i JOIN harness.node_resource_runtimes runtime
          ON runtime.organization_id=i.organization_id AND runtime.node_id=i.assigned_node_id
          AND runtime.runtime_id=i.runtime_id AND runtime.runtime_kind=next_request.runtime_kind
          AND runtime.runtime_public_id=next_request.runtime_public_id AND runtime.generation=next_request.generation
        WHERE i.organization_id=tenant AND i.assigned_node_id=computer AND i.generation=next_request.generation
          AND i.desired_state='running' AND i.observed_state IN ('starting','ready')
          AND harness.runtime_node_execution_allowed(i.organization_id,i.assigned_node_id,
            i.node_connection_id,i.node_connection_epoch)))
      AND EXISTS(SELECT 1 FROM harness.node_resource_requests request
        WHERE request.organization_id=tenant AND request.node_id=computer
          AND request.runtime_kind=next_request.runtime_kind AND request.runtime_public_id=next_request.runtime_public_id
          AND request.generation=next_request.generation AND request.sequence=next_request.sequence
          AND request.state='queued' AND request.deadline>clock_timestamp());
    GET DIAGNOSTICS changed=ROW_COUNT;
    IF changed=0 THEN
      WITH expired AS (
        DELETE FROM harness.node_resource_requests WHERE organization_id=tenant AND node_id=computer
          AND state='queued' AND deadline<=clock_timestamp() RETURNING sequence
      ) SELECT count(*) INTO changed FROM expired;
      IF changed=0 THEN RETURN; END IF;
      UPDATE harness.node_resource_state SET timed_out=timed_out+changed
        WHERE organization_id=tenant AND node_id=computer;
      CONTINUE;
    END IF;
    UPDATE harness.node_resource_requests SET state='active',granted_at=clock_timestamp()
      WHERE organization_id=tenant AND node_id=computer AND runtime_kind=next_request.runtime_kind
        AND runtime_public_id=next_request.runtime_public_id AND generation=next_request.generation
        AND sequence=next_request.sequence;
    UPDATE harness.node_resource_state SET next_turn=next_turn+1
      WHERE organization_id=tenant AND node_id=computer RETURNING next_turn INTO next_position;
    UPDATE harness.node_resource_requests SET user_turn=next_position
      WHERE organization_id=tenant AND node_id=computer AND actor_public_id=next_request.actor_public_id AND state='queued';
    UPDATE harness.node_resource_requests SET project_turn=next_position
      WHERE organization_id=tenant AND node_id=computer AND actor_public_id=next_request.actor_public_id
        AND project_public_id=next_request.project_public_id AND state='queued';
  END LOOP;
END;
$$;
