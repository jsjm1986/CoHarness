-- The caller commits the decision, or rolls back refused identities and deadlines.
CREATE FUNCTION harness.admit_runtime_start(tenant uuid, computer uuid, owner_kind text,
  owner_id bigint, owner_generation bigint, environment uuid, initial_limits jsonb, elapsed_ms double precision)
RETURNS TABLE(state text, limits jsonb)
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  max_wait_ms integer;
  allocation record;
  changed bigint;
  entered_at timestamptz := clock_timestamp();
BEGIN
  PERFORM set_config('lock_timeout',CASE WHEN current_setting('statement_timeout')='0'
    THEN current_setting('lock_timeout') ELSE current_setting('statement_timeout') END,true);
  limits := harness.lock_node_resources(tenant,computer,initial_limits);
  max_wait_ms := (limits->>'maxWaitMs')::integer;
  SELECT i.id,i.allocation_state INTO allocation FROM harness.instances i
    LEFT JOIN harness.users u ON u.id=i.user_id LEFT JOIN harness.projects p ON p.id=i.project_id
    WHERE i.organization_id=tenant AND i.assigned_node_id=computer
      AND CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END=owner_kind
      AND COALESCE(u.public_id,p.public_id)=owner_id AND i.generation=owner_generation
      AND (environment IS NULL OR i.runtime_id=environment)
      AND i.observed_state='starting' AND i.desired_state='running'
      AND harness.runtime_node_execution_allowed(i.organization_id,i.assigned_node_id,i.node_connection_id,i.node_connection_epoch)
    FOR UPDATE OF i;
  IF NOT FOUND OR allocation.allocation_state NOT IN ('not-started','waiting') THEN
    state := 'stale-generation'; RETURN NEXT; RETURN;
  END IF;
  UPDATE harness.instances SET allocation_state='waiting',updated_at=now() WHERE id=allocation.id;
  PERFORM harness.schedule_node_resources(tenant,computer);
  IF elapsed_ms + EXTRACT(EPOCH FROM clock_timestamp()-entered_at)*1000 >= max_wait_ms THEN
    state := 'timeout'; RETURN NEXT; RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM harness.instances i
    LEFT JOIN harness.users u ON u.id=i.user_id LEFT JOIN harness.projects p ON p.id=i.project_id
    WHERE i.organization_id=tenant AND i.assigned_node_id=computer
      AND i.observed_state IN ('ready','starting','stopping')
      AND NOT(i.observed_state='starting' AND i.allocation_state IN ('not-started','waiting'))
      AND NOT EXISTS(SELECT 1 FROM harness.node_resource_runtimes r
        WHERE r.organization_id=i.organization_id AND r.node_id=i.assigned_node_id
          AND r.runtime_kind=CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END
          AND r.runtime_public_id=COALESCE(u.public_id,p.public_id)
          AND r.generation=i.generation AND r.runtime_id=i.runtime_id)) THEN
    state := 'waiting'; RETURN NEXT; RETURN;
  END IF;
  UPDATE harness.node_resource_state SET credits=credits-1,runtime_starts_admitted=runtime_starts_admitted+1
    WHERE organization_id=tenant AND node_id=computer AND credits>0 AND valid_until>clock_timestamp();
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed=0 THEN state := 'waiting'; RETURN NEXT; RETURN; END IF;
  UPDATE harness.instances SET allocation_state='possible',updated_at=now() WHERE id=allocation.id;
  state := 'admitted'; RETURN NEXT;
END;
$$;
