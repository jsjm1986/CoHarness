-- Personal execution keeps the original Session and actor locks while committing one client statement.
CREATE FUNCTION harness.personal_execution_actor(
  tenant uuid, computer uuid, allocation uuid, allocation_generation bigint, bearer_hash bytea,
  write_epoch bigint, public_actor bigint
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  actor uuid;
  serving_mode text;
  serving_epoch bigint;
BEGIN
  SELECT u.id INTO actor FROM harness.users u
    JOIN harness.memberships m ON (m.organization_id,m.user_id)=(u.organization_id,u.id)
    WHERE u.organization_id=tenant AND u.public_id=public_actor
      AND u.status='active' AND u.deleted_at IS NULL AND m.status='active'
    FOR SHARE OF u,m;

  -- The actor lock may wait for a computer grant change. Read that grant and the generation afterwards.
  SELECT COALESCE(c.mode,'serving'),COALESCE(c.write_epoch,1) INTO serving_mode,serving_epoch
    FROM harness.organizations o LEFT JOIN harness.cluster_control c ON c.organization_id=o.id
    WHERE o.id=tenant AND o.status='active';
  IF actor IS NULL OR serving_mode IS NULL OR NOT EXISTS (
    SELECT FROM harness.instances i WHERE i.organization_id=tenant AND i.assigned_node_id=computer
      AND i.runtime_id=allocation AND i.user_id=actor AND i.generation=allocation_generation
      AND i.runtime_token_hash=bearer_hash AND i.provisioning_state='ready'
      AND i.desired_state='running' AND i.observed_state IN ('starting','ready')
      AND harness.runtime_node_execution_allowed(tenant,computer,i.node_connection_id,i.node_connection_epoch)
      AND harness.computer_use_allowed(tenant,actor,computer)
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P4101', MESSAGE='personal execution is no longer authorized';
  END IF;
  IF serving_epoch<>write_epoch OR serving_mode<>'serving' THEN
    RAISE EXCEPTION USING ERRCODE='P4104', MESSAGE='execution writes are unavailable';
  END IF;
  RETURN actor;
END
$$;

CREATE FUNCTION harness.register_personal_execution_root(
  tenant uuid, computer uuid, allocation uuid, allocation_generation bigint, bearer_hash bytea,
  write_epoch bigint, public_actor bigint, session_key text
) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  stored_parent text;
  stored_seeded boolean;
BEGIN
  INSERT INTO harness.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,parent_session_id,is_seeded)
    VALUES(tenant,'user',public_actor,session_key,allocation,NULL,false) ON CONFLICT DO NOTHING;
  SELECT s.parent_session_id,s.is_seeded INTO stored_parent,stored_seeded
    FROM harness.execution_sessions s WHERE s.organization_id=tenant AND s.runtime_kind='user'
      AND s.runtime_public_id=public_actor AND s.session_id=session_key AND s.runtime_id=allocation
    FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P4102', MESSAGE='execution Session is not registered in this runtime';
  END IF;
  PERFORM harness.personal_execution_actor(tenant,computer,allocation,allocation_generation,bearer_hash,write_epoch,public_actor);
  IF stored_parent IS NOT NULL OR stored_seeded THEN
    RAISE EXCEPTION USING ERRCODE='P4103', MESSAGE='execution Session lineage is immutable';
  END IF;
END
$$;

CREATE FUNCTION harness.admit_personal_execution_input(
  tenant uuid, computer uuid, allocation uuid, allocation_generation bigint, bearer_hash bytea,
  write_epoch bigint, public_actor bigint, session_key text, message_key text, message_hash text
) RETURNS TABLE (input_id uuid, public_actors text[]) LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  session_exists boolean;
  actor uuid;
  receipt harness.execution_inputs%ROWTYPE;
BEGIN
  PERFORM 1 FROM harness.execution_sessions s WHERE s.organization_id=tenant AND s.runtime_kind='user'
    AND s.runtime_public_id=public_actor AND s.session_id=session_key AND s.runtime_id=allocation
    FOR UPDATE OF s;
  session_exists := FOUND;
  actor := harness.personal_execution_actor(tenant,computer,allocation,allocation_generation,bearer_hash,write_epoch,public_actor);
  IF NOT session_exists THEN
    RAISE EXCEPTION USING ERRCODE='P4102', MESSAGE='execution Session is not registered in this runtime';
  END IF;

  SELECT i.* INTO receipt FROM harness.execution_inputs i WHERE i.organization_id=tenant AND i.runtime_kind='user'
    AND i.runtime_public_id=public_actor AND i.session_id=session_key AND i.runtime_id=allocation AND i.message_id=message_key
    AND i.kind='message' AND i.previous_input_id IS NULL;
  IF FOUND THEN
    IF receipt.created_by_user_id<>actor OR receipt.content_hash<>message_hash THEN
      RAISE EXCEPTION USING ERRCODE='P4103', MESSAGE='execution input identity conflicts with an earlier admission';
    END IF;
    SELECT array_agg(u.public_id::text ORDER BY u.public_id) INTO public_actors FROM harness.users u
      WHERE u.organization_id=tenant AND u.id=ANY(receipt.actor_user_ids);
    IF COALESCE(cardinality(public_actors),0)<>cardinality(receipt.actor_user_ids) THEN
      RAISE EXCEPTION USING ERRCODE='P4101', MESSAGE='execution actor record is unavailable';
    END IF;
    input_id := receipt.id;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO harness.execution_inputs(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,message_id,
    kind,content_hash,created_by_user_id,actor_user_ids,previous_input_id)
    VALUES(tenant,'user',public_actor,session_key,allocation,message_key,'message',message_hash,actor,ARRAY[actor],NULL)
    RETURNING * INTO receipt;
  input_id := receipt.id;
  public_actors := ARRAY[public_actor::text];
  RETURN NEXT;
END
$$;
