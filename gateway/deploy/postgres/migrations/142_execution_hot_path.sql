-- These calls retain the node row and exact owner locks through the caller's commit.
CREATE FUNCTION harness.lock_current_node_resource_owner(tenant uuid, computer uuid, owner_kind text,
  owner_id bigint, owner_generation bigint, environment uuid, process_owner uuid, cleanup boolean)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  current_runtime uuid;
BEGIN
  IF owner_kind='gateway' THEN
    PERFORM 1 FROM harness.node_resource_gateways g WHERE g.organization_id=tenant AND g.node_id=computer
      AND g.owner_id=process_owner AND g.generation=owner_generation
      AND (cleanup OR harness.node_execution_available(tenant,computer)) FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P4201',MESSAGE='Gateway resource owner is no longer current';
    END IF;
    RETURN NULL;
  END IF;

  SELECT i.runtime_id INTO STRICT current_runtime FROM harness.instances i
    LEFT JOIN harness.users u ON u.id=i.user_id LEFT JOIN harness.projects p ON p.id=i.project_id
    WHERE i.organization_id=tenant AND i.assigned_node_id=computer
      AND CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END=owner_kind
      AND COALESCE(u.public_id,p.public_id)=owner_id AND i.generation=owner_generation
      AND (environment IS NULL OR i.runtime_id=environment)
      AND (i.observed_state IN ('starting','ready') OR (cleanup AND i.observed_state='stopping'))
      AND (cleanup OR harness.runtime_node_execution_allowed(tenant,computer,i.node_connection_id,i.node_connection_epoch))
    FOR SHARE OF i;
  RETURN current_runtime;
EXCEPTION WHEN no_data_found OR too_many_rows THEN
  RAISE EXCEPTION USING ERRCODE='P4201',MESSAGE='resource Runtime generation is no longer current';
END
$$;

CREATE FUNCTION harness.request_node_resource(tenant uuid, computer uuid, owner_kind text, owner_id bigint,
  owner_generation bigint, environment uuid, process_owner uuid, initial_limits jsonb, request_sequence bigint,
  request_operation uuid, resource_kind text, actor bigint, project bigint, session_key text,
  request_fingerprint text, request_bytes integer, scope_key uuid, origin text, administrative boolean)
RETURNS TABLE (limits jsonb, state text, refusal text)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  current_runtime uuid;
  prior_fingerprint text;
  stored_operation uuid;
  last_registered bigint;
  queued_count bigint;
  kind_count bigint;
  actor_count bigint;
  project_count bigint;
  reserved_bytes bigint;
  actor_turn bigint;
  workspace_turn bigint;
  next_position bigint;
  fresh_credit boolean;
BEGIN
  PERFORM set_config('lock_timeout',CASE WHEN current_setting('statement_timeout')='0'
    THEN current_setting('lock_timeout') ELSE current_setting('statement_timeout') END,true);
  limits := harness.lock_node_resources(tenant,computer,initial_limits);
  current_runtime := harness.lock_current_node_resource_owner(tenant,computer,owner_kind,owner_id,owner_generation,
    environment,process_owner,false);

  SELECT r.fingerprint INTO prior_fingerprint FROM harness.node_resource_requests r
    WHERE (r.organization_id,r.node_id,r.runtime_kind,r.runtime_public_id,r.generation,r.sequence)
      =(tenant,computer,owner_kind,owner_id,owner_generation,request_sequence);
  IF FOUND THEN
    IF prior_fingerprint<>request_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE='P4202',MESSAGE='resource request conflicts with its first registration';
    END IF;
  ELSE
    SELECT r.last_sequence INTO last_registered FROM harness.node_resource_runtimes r
      WHERE (r.organization_id,r.node_id,r.runtime_kind,r.runtime_public_id,r.generation)
        =(tenant,computer,owner_kind,owner_id,owner_generation);
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P4203',MESSAGE='resource Runtime is not registered';
    END IF;
    IF request_sequence<=last_registered THEN
      state := 'closed';
      RETURN NEXT;
      RETURN;
    END IF;
    IF request_sequence<>last_registered+1 THEN
      RAISE EXCEPTION USING ERRCODE='P4204',MESSAGE='resource registration sequence is not contiguous';
    END IF;
    IF EXISTS(SELECT 1 FROM harness.node_resource_requests r
      WHERE (r.organization_id,r.node_id,r.runtime_kind,r.runtime_public_id,r.generation,r.operation_id)
        =(tenant,computer,owner_kind,owner_id,owner_generation,request_operation)) THEN
      RAISE EXCEPTION USING ERRCODE='P4205',MESSAGE='resource operation is already registered at another sequence';
    END IF;

    UPDATE harness.node_resource_runtimes r SET last_sequence=request_sequence
      WHERE (r.organization_id,r.node_id,r.runtime_kind,r.runtime_public_id,r.generation)
        =(tenant,computer,owner_kind,owner_id,owner_generation);
    PERFORM harness.schedule_node_resources(tenant,computer);

    SELECT count(*) FILTER (WHERE r.state='queued'),
      count(*) FILTER (WHERE r.state='queued' AND r.kind=resource_kind),
      count(*) FILTER (WHERE r.state='queued' AND r.actor_public_id=actor),
      count(*) FILTER (WHERE r.state='queued' AND r.project_public_id=project),
      COALESCE(sum(r.queued_bytes),0),
      min(r.user_turn) FILTER (WHERE r.state='queued' AND r.actor_public_id=actor),
      min(r.project_turn) FILTER (WHERE r.state='queued' AND r.actor_public_id=actor AND r.project_public_id=project)
      INTO queued_count,kind_count,actor_count,project_count,reserved_bytes,actor_turn,workspace_turn
      FROM harness.node_resource_requests r WHERE r.organization_id=tenant AND r.node_id=computer;
    SELECT s.credits>0 AND s.valid_until>clock_timestamp() AND harness.node_execution_available(tenant,computer)
      INTO fresh_credit FROM harness.node_resource_state s WHERE s.organization_id=tenant AND s.node_id=computer;
    IF NOT COALESCE(fresh_credit,false) OR kind_count<>0 OR EXISTS(SELECT 1 FROM harness.instances i
      LEFT JOIN harness.users u ON u.id=i.user_id LEFT JOIN harness.projects p ON p.id=i.project_id
      WHERE i.organization_id=tenant AND i.assigned_node_id=computer AND i.observed_state IN ('ready','starting','stopping')
        AND NOT (i.observed_state='starting' AND i.allocation_state IN ('not-started','waiting'))
        AND NOT EXISTS(SELECT 1 FROM harness.node_resource_runtimes r WHERE r.organization_id=tenant AND r.node_id=computer
          AND r.runtime_kind=CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END
          AND r.runtime_public_id=COALESCE(u.public_id,p.public_id) AND r.generation=i.generation AND r.runtime_id=i.runtime_id)) THEN
      IF owner_kind<>'gateway' AND session_key IS NOT NULL AND NOT COALESCE(fresh_credit,false) AND EXISTS(
        WITH RECURSIVE chain AS (
          SELECT s.session_id,s.parent_session_id FROM harness.execution_sessions s
            WHERE (s.organization_id,s.runtime_kind,s.runtime_public_id,s.runtime_id,s.session_id)
              =(tenant,owner_kind,owner_id,current_runtime,session_key)
          UNION ALL
          SELECT s.session_id,s.parent_session_id FROM harness.execution_sessions s JOIN chain ON s.session_id=chain.parent_session_id
            WHERE (s.organization_id,s.runtime_kind,s.runtime_public_id,s.runtime_id)=(tenant,owner_kind,owner_id,current_runtime)
        ) SELECT 1 FROM chain JOIN harness.node_resource_requests r USING (session_id)
          WHERE (r.organization_id,r.node_id,r.runtime_kind,r.runtime_public_id,r.generation,r.kind)
            =(tenant,computer,owner_kind,owner_id,owner_generation,resource_kind) AND r.state<>'queued'
      ) THEN refusal := 'nested-capacity';
      ELSIF queued_count>=(limits->>'maxQueued')::bigint THEN refusal := 'queue-full';
      ELSIF actor_count>=(limits->>'maxQueuedPerUser')::bigint THEN refusal := 'user-queue-full';
      ELSIF project<>0 AND project_count>=(limits->>'maxQueuedPerProject')::bigint THEN refusal := 'project-queue-full';
      END IF;
    END IF;
    IF refusal IS NULL AND reserved_bytes+request_bytes>(limits->>'maxQueuedBytes')::bigint THEN refusal := 'queue-bytes'; END IF;
    IF refusal IS NOT NULL THEN
      UPDATE harness.node_resource_state s SET rejected=s.rejected+1 WHERE s.organization_id=tenant AND s.node_id=computer;
      state := 'refused';
      RETURN NEXT;
      RETURN;
    END IF;

    UPDATE harness.node_resource_state s SET next_turn=s.next_turn+1 WHERE s.organization_id=tenant AND s.node_id=computer
      RETURNING s.next_turn INTO next_position;
    INSERT INTO harness.node_resource_requests
      (organization_id,node_id,runtime_kind,runtime_public_id,generation,sequence,operation_id,kind,actor_public_id,project_public_id,
       session_id,fingerprint,state,user_turn,project_turn,queued_bytes,deadline,scope_id,origin_kind,principal_admin)
      VALUES(tenant,computer,owner_kind,owner_id,owner_generation,request_sequence,request_operation,resource_kind,actor,project,
        session_key,request_fingerprint,'queued',COALESCE(actor_turn,next_position),COALESCE(workspace_turn,next_position),
        request_bytes,clock_timestamp()+(limits->>'maxWaitMs')::integer*interval '1 millisecond',scope_key,origin,administrative);
  END IF;

  PERFORM harness.schedule_node_resources(tenant,computer);
  SELECT r.state,r.operation_id INTO state,stored_operation FROM harness.node_resource_requests r
    WHERE (r.organization_id,r.node_id,r.runtime_kind,r.runtime_public_id,r.generation,r.sequence)
      =(tenant,computer,owner_kind,owner_id,owner_generation,request_sequence);
  IF FOUND AND stored_operation IS DISTINCT FROM request_operation THEN
    RAISE EXCEPTION USING ERRCODE='P4206',MESSAGE='resource operation does not own this sequence';
  END IF;
  state := COALESCE(state,'closed');
  RETURN NEXT;
END
$$;

CREATE FUNCTION harness.read_node_resource_admissions(tenant uuid, computer uuid, owner_kind text, owner_id bigint,
  owner_generation bigint, environment uuid, process_owner uuid, initial_limits jsonb, sequences bigint[])
RETURNS TABLE (limits jsonb, admissions jsonb)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM set_config('lock_timeout',CASE WHEN current_setting('statement_timeout')='0'
    THEN current_setting('lock_timeout') ELSE current_setting('statement_timeout') END,true);
  limits := harness.lock_node_resources(tenant,computer,initial_limits);
  PERFORM harness.lock_current_node_resource_owner(tenant,computer,owner_kind,owner_id,owner_generation,
    environment,process_owner,false);
  PERFORM harness.schedule_node_resources(tenant,computer);
  SELECT COALESCE(jsonb_agg(a),'[]'::jsonb) INTO admissions FROM (
    SELECT r.sequence::text,r.operation_id::text,r.state,r.origin_kind,r.session_id,r.scope_id::text,
      r.actor_public_id::text,r.principal_admin FROM harness.node_resource_requests r
      WHERE (r.organization_id,r.node_id,r.runtime_kind,r.runtime_public_id,r.generation)
        =(tenant,computer,owner_kind,owner_id,owner_generation) AND r.sequence=ANY(sequences)
  ) a;
  RETURN NEXT;
END
$$;

-- Every execution guard checks the same immutable witnesses and the current authority.
CREATE FUNCTION harness.authorize_personal_execution_scope(tenant uuid, computer uuid, allocation uuid,
  allocation_generation bigint, bearer_hash bytea, write_epoch bigint, public_actor bigint, session_key text, scope_key uuid)
RETURNS TABLE (revision text, input_ids uuid[], unverified boolean)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  captured harness.execution_scopes%ROWTYPE;
  actor uuid;
BEGIN
  SELECT s.* INTO captured FROM harness.execution_scopes s
    WHERE (s.organization_id,s.runtime_kind,s.runtime_public_id,s.runtime_id,s.session_id,s.id)
      =(tenant,'user',public_actor,allocation,session_key,scope_key);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='execution scope belongs to another Session or runtime';
  END IF;

  actor := harness.personal_execution_actor(tenant,computer,allocation,allocation_generation,bearer_hash,write_epoch,public_actor);
  IF captured.primary_actor_user_id IS DISTINCT FROM actor OR cardinality(captured.input_ids)=0 OR EXISTS(
    SELECT 1 FROM unnest(captured.input_ids) input_id WHERE NOT EXISTS(
      SELECT FROM harness.execution_inputs i WHERE (i.organization_id,i.runtime_kind,i.runtime_public_id,i.runtime_id,i.id)
        =(tenant,'user',public_actor,allocation,input_id) AND i.actor_user_ids <@ ARRAY[actor]
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P4101',MESSAGE='execution scope has no eligible complete actor set';
  END IF;
  RETURN QUERY SELECT captured.revision::text,captured.input_ids,captured.unverified;
END
$$;
