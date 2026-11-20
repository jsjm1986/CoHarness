-- The caller validates the returned policy before committing the registration.
CREATE FUNCTION harness.register_runtime_resources(tenant uuid, computer uuid, owner_kind text,
  owner_id bigint, owner_generation bigint, environment uuid, initial_limits jsonb)
RETURNS TABLE(next_sequence bigint, limits jsonb)
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  current_runtime uuid;
  last_sequence bigint;
BEGIN
  PERFORM set_config('lock_timeout',CASE WHEN current_setting('statement_timeout')='0'
    THEN current_setting('lock_timeout') ELSE current_setting('statement_timeout') END,true);
  limits := harness.lock_node_resources(tenant,computer,initial_limits);
  BEGIN
    SELECT i.runtime_id INTO STRICT current_runtime FROM harness.instances i
      LEFT JOIN harness.users u ON u.id=i.user_id LEFT JOIN harness.projects p ON p.id=i.project_id
      WHERE i.organization_id=tenant AND i.assigned_node_id=computer
        AND CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END=owner_kind
        AND COALESCE(u.public_id,p.public_id)=owner_id AND i.generation=owner_generation
        AND i.observed_state IN ('starting','ready')
        AND (environment IS NULL OR i.runtime_id=environment)
        AND harness.runtime_node_execution_allowed(i.organization_id,i.assigned_node_id,
          i.node_connection_id,i.node_connection_epoch)
      FOR SHARE OF i;
  EXCEPTION WHEN no_data_found OR too_many_rows THEN
    RAISE EXCEPTION 'resource Runtime generation is no longer current'
      USING ERRCODE='55000',CONSTRAINT='node_resource_registration_generation';
  END;
  INSERT INTO harness.node_resource_runtimes AS registration
    (organization_id,node_id,runtime_kind,runtime_public_id,generation,runtime_id)
    VALUES(tenant,computer,owner_kind,owner_id,owner_generation,current_runtime)
    ON CONFLICT(organization_id,node_id,runtime_kind,runtime_public_id,generation)
    DO UPDATE SET runtime_id=excluded.runtime_id
      WHERE registration.runtime_id IS NULL OR registration.runtime_id=excluded.runtime_id
    RETURNING registration.last_sequence INTO last_sequence;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Runtime resource registration belongs to another environment'
      USING ERRCODE='55000',CONSTRAINT='node_resource_registration_identity';
  END IF;
  next_sequence := last_sequence + 1;
  RETURN NEXT;
END;
$$;
