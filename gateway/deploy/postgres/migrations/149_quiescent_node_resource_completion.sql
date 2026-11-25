-- False means the stored policy did not qualify; accounting has not run.
CREATE FUNCTION harness.complete_quiescent_node_resource(tenant uuid, computer uuid, owner_kind text,
  owner_id bigint, owner_generation bigint, environment uuid, process_owner uuid, request_sequence bigint,
  request_operation text, configured_limits jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  last_registered bigint;
  mismatched boolean;
BEGIN
  PERFORM set_config('lock_timeout',CASE WHEN current_setting('statement_timeout')='0'
    THEN current_setting('lock_timeout') ELSE current_setting('statement_timeout') END,true);
  PERFORM 1 FROM harness.node_resource_state
    WHERE organization_id=tenant AND node_id=computer AND limits=configured_limits FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  PERFORM harness.lock_node_resources(tenant,computer,configured_limits);
  -- A fresh snapshot includes any registration that committed while the node lock was held elsewhere.
  WITH receipt AS MATERIALIZED (
    SELECT runtime.last_sequence, EXISTS (
      SELECT FROM harness.node_resource_requests request
        WHERE (request.organization_id,request.node_id,request.runtime_kind,request.runtime_public_id,request.generation,request.sequence)
          =(tenant,computer,owner_kind,owner_id,owner_generation,request_sequence)
          AND request.operation_id::text IS DISTINCT FROM request_operation
    ) AS owner_mismatch FROM harness.node_resource_runtimes runtime
      WHERE (runtime.organization_id,runtime.node_id,runtime.runtime_kind,runtime.runtime_public_id,runtime.generation)
        =(tenant,computer,owner_kind,owner_id,owner_generation)
  ), removed AS (
    DELETE FROM harness.node_resource_requests request
      WHERE (request.organization_id,request.node_id,request.runtime_kind,request.runtime_public_id,request.generation,request.sequence)
        =(tenant,computer,owner_kind,owner_id,owner_generation,request_sequence)
        AND request_operation IS NOT NULL
        AND EXISTS (SELECT FROM receipt WHERE last_sequence>=0 AND last_sequence>=request_sequence AND NOT owner_mismatch)
    RETURNING 1
  ), counted AS (
    UPDATE harness.node_resource_state SET completed=completed+1
      WHERE organization_id=tenant AND node_id=computer AND EXISTS (SELECT FROM removed)
  ) SELECT last_sequence,owner_mismatch INTO last_registered,mismatched FROM receipt;
  IF last_registered IS NULL OR last_registered<0 OR request_sequence IS NULL OR request_sequence>last_registered THEN
    RAISE EXCEPTION USING ERRCODE='P4207',MESSAGE='unknown resource completion sequence';
  END IF;
  IF request_operation IS NULL OR mismatched THEN
    RAISE EXCEPTION USING ERRCODE='P4206',MESSAGE='resource operation does not own this sequence';
  END IF;

  PERFORM harness.schedule_node_resources(tenant,computer);
  -- The exact owner lock must not block instance activity while scheduling waits.
  PERFORM harness.lock_current_node_resource_owner(tenant,computer,owner_kind,owner_id,owner_generation,
    environment,process_owner,true);
  RETURN true;
END
$$;
