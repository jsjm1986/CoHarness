-- Observe round in one call: node lock, stale-request sweep, pressure update and
-- conditional scheduling used to cross the client link as ~7 serial statements,
-- which multiplied by a tunnel RTT throttled high-latency nodes.
-- elapsed_ms is the caller-side capture age at dispatch. Adding the in-function
-- wait reproduces the former post-lock measurement: an observation that expires
-- while queued for the node lock is dropped instead of renewing credits.
-- Lock waiting inherits the statement bound exactly like the client wrapper's
-- lockWait:'statement' option: inside one implicit transaction set_config(...,true)
-- covers this call only.
CREATE OR REPLACE FUNCTION harness.observe_node_resources(tenant uuid, computer uuid, sample jsonb, elapsed_ms double precision, initial_limits jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
  current_limits jsonb;
  stale_ms double precision;
  sample_ms double precision;
  computed integer;
  expired_count bigint;
  changed bigint;
  waited_ms double precision;
  entry timestamp := clock_timestamp();
BEGIN
  PERFORM set_config('lock_timeout',CASE WHEN current_setting('statement_timeout')='0'
    THEN current_setting('lock_timeout') ELSE current_setting('statement_timeout') END,true);
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
  stale_ms := (current_limits->>'staleMs')::double precision;
  sample_ms := (current_limits->>'sampleMs')::double precision;
  waited_ms := elapsed_ms + EXTRACT(EPOCH FROM clock_timestamp()-entry)*1000;
  IF waited_ms >= stale_ms THEN
    RETURN jsonb_build_object('applied',false);
  END IF;
  computed := CASE WHEN sample->>'memory'='normal'
    AND (sample->>'memoryAvailableRatio' IS NULL
         OR (sample->>'memoryAvailableRatio')::double precision > (current_limits->>'linuxMemoryReserveRatio')::double precision)
    AND (sample->>'cpu')::double precision < (current_limits->>'cpuTarget')::double precision
    AND (sample->>'eventLoopMs')::double precision < (current_limits->>'eventLoopTargetMs')::double precision
    THEN GREATEST(1,floor((sample->>'parallelism')::double precision*(1-(sample->>'cpu')::double precision)))::integer
    ELSE 0 END;
  -- The client formerly bracketed capture with two post-lock ages; transit folds
  -- them into one bound here, which the monotonic gates still accept.
  WITH observation AS MATERIALIZED (
    SELECT clock_timestamp()-waited_ms*interval '1 millisecond' captured_at
  ) UPDATE harness.node_resource_state SET pressure=sample,sampled_at=observation.captured_at,
      sampled_before=GREATEST(sampled_before,observation.captured_at),
      valid_until=CASE WHEN computed=0 THEN GREATEST(valid_until,observation.captured_at+stale_ms*interval '1 millisecond')
        ELSE observation.captured_at+stale_ms*interval '1 millisecond' END,credits=computed
    FROM observation WHERE organization_id=tenant AND node_id=computer
      AND observation.captured_at+stale_ms*interval '1 millisecond'>clock_timestamp()
      AND (computed=0 OR sampled_before IS NULL OR sampled_before<=observation.captured_at-sample_ms*interval '1 millisecond');
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed>0 THEN
    PERFORM harness.schedule_node_resources(tenant,computer);
  END IF;
  RETURN jsonb_build_object('applied',changed>0);
END;
$$;
