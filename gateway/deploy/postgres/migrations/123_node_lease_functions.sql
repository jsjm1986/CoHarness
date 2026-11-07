-- Collapse the node-agent control-channel authorization and lease heartbeat
-- transactions into one statement each. Both paths repeated the same serial
-- sequence (BEGIN; lock checks; optional lease update; COMMIT) on every call,
-- which multiplied by a WAN tunnel RTT held the row lock and a pooled
-- connection far longer than the work requires. The functions keep the exact
-- check order and error taxonomy of the TypeScript callers they replace:
-- mode-disabled, unauthorized, detached and lease-lost remain distinguishable.
-- Check-and-write stay inside one statement, so no generation or lease fence
-- can be observed mid-flight; FOR UPDATE/FOR SHARE acquisition order matches
-- the former transaction (topology read, then agent row, then organization).
-- The credential lookup resolves the node id before the locking read so a
-- concurrent credential mutation keeps the row identity, and the locked row's
-- credential hash is rechecked afterwards — the same two-step shape the former
-- target/locked CTEs used. Lease freshness is compared after the locking
-- SELECT returns: an expression in the locking SELECT's target list would be
-- computed before the lock wait ends, which could return an expired lease as
-- live.

CREATE FUNCTION harness.node_channel_lease(
  tenant uuid, token_hash bytea, wanted_connection uuid, wanted_epoch text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  found uuid;
  agent record;
BEGIN
  SELECT node_id INTO found FROM harness.node_agents
    WHERE organization_id=tenant AND credential_hash=token_hash;
  SELECT a.* INTO agent
    FROM harness.node_agents a
    JOIN harness.organizations o ON o.id=a.organization_id AND o.status='active'
    WHERE a.organization_id=tenant AND a.node_id=found
    FOR SHARE OF a FOR SHARE OF o;
  IF agent.node_id IS NULL THEN
    RETURN jsonb_build_object('status','unauthorized');
  END IF;
  IF agent.attachment_state='detached' THEN
    RETURN jsonb_build_object('status','detached');
  END IF;
  IF agent.revoked_at IS NOT NULL OR agent.credential_hash IS DISTINCT FROM token_hash THEN
    RETURN jsonb_build_object('status','unauthorized');
  END IF;
  IF agent.lease_expires_at IS NULL OR agent.lease_expires_at<=clock_timestamp()
      OR agent.connection_id IS DISTINCT FROM wanted_connection
      OR agent.connection_epoch::text IS DISTINCT FROM wanted_epoch THEN
    RETURN jsonb_build_object('status','lease-lost');
  END IF;
  RETURN jsonb_build_object('status','ok','nodeId',agent.node_id,
    'connectionId',agent.connection_id,'epoch',agent.connection_epoch::text,
    'executionReady',agent.execution_ready,
    'expiresAtMs',extract(epoch from agent.lease_expires_at)*1000);
END $$;

CREATE FUNCTION harness.node_heartbeat(
  tenant uuid, token_hash bytea, wanted_connection uuid, wanted_epoch text,
  lease_ms double precision, computer uuid
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  gate boolean;
  found uuid;
  agent record;
  new_expiry timestamptz;
BEGIN
  SELECT true INTO gate FROM harness.deployment_topology
    WHERE organization_id=tenant AND ((enabled AND primary_node_id=computer)
      OR (legacy_initialization_required AND NOT EXISTS(SELECT 1 FROM harness.node_agents a
        WHERE a.organization_id=tenant AND a.node_id=computer))) FOR SHARE;
  IF gate IS NULL THEN
    RETURN jsonb_build_object('status','mode-disabled');
  END IF;
  SELECT node_id INTO found FROM harness.node_agents
    WHERE organization_id=tenant AND credential_hash=token_hash;
  SELECT a.* INTO agent
    FROM harness.node_agents a
    JOIN harness.organizations o ON o.id=a.organization_id AND o.status='active'
    WHERE a.organization_id=tenant AND a.node_id=found
    FOR UPDATE OF a FOR SHARE OF o;
  IF agent.node_id IS NULL THEN
    RETURN jsonb_build_object('status','unauthorized');
  END IF;
  IF agent.attachment_state='detached' THEN
    RETURN jsonb_build_object('status','detached');
  END IF;
  IF agent.revoked_at IS NOT NULL OR agent.credential_hash IS DISTINCT FROM token_hash THEN
    RETURN jsonb_build_object('status','unauthorized');
  END IF;
  IF agent.lease_expires_at IS NULL OR agent.lease_expires_at<=clock_timestamp()
      OR agent.connection_id IS DISTINCT FROM wanted_connection
      OR agent.connection_epoch::text IS DISTINCT FROM wanted_epoch THEN
    RETURN jsonb_build_object('status','lease-lost');
  END IF;
  UPDATE harness.node_agents
    SET lease_expires_at=clock_timestamp()+lease_ms*interval '1 millisecond',last_seen_at=clock_timestamp()
    WHERE organization_id=tenant AND node_id=agent.node_id AND lease_expires_at>clock_timestamp()
    RETURNING lease_expires_at INTO new_expiry;
  IF new_expiry IS NULL THEN
    RETURN jsonb_build_object('status','lease-lost');
  END IF;
  RETURN jsonb_build_object('status','ok','nodeId',agent.node_id,
    'connectionId',agent.connection_id,'epoch',agent.connection_epoch::text,
    'executionReady',agent.execution_ready,
    'expiresAtMs',extract(epoch from new_expiry)*1000);
END $$;
