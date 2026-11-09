-- 126 gated `node_channel_lease` on the caller being the topology primary, but
-- the function also serves the node-local `/internal/nodes/service` identity
-- check on every secondary Gateway: the service bridge verifies the agent's
-- current lease against its own computer id, so every non-primary caller was
-- refused as `mode-disabled` and remote service routing stopped working.
-- The caller's node id is still authoritative for cross-computer decisions;
-- a Gateway may always authorize the lease of an agent enrolled on itself.

CREATE OR REPLACE FUNCTION harness.node_channel_lease(
  tenant uuid, token_hash bytea, wanted_connection uuid, wanted_epoch text, computer uuid
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  gate boolean;
  found uuid;
  agent record;
BEGIN
  SELECT node_id INTO found FROM harness.node_agents
    WHERE organization_id=tenant AND credential_hash=token_hash;
  SELECT true INTO gate FROM harness.deployment_topology
    WHERE organization_id=tenant AND ((enabled AND primary_node_id=computer)
      OR (legacy_initialization_required AND NOT EXISTS(SELECT 1 FROM harness.node_agents a
        WHERE a.organization_id=tenant AND a.node_id=computer))) FOR SHARE;
  IF gate IS NULL AND found IS DISTINCT FROM computer THEN
    RETURN jsonb_build_object('status','mode-disabled');
  END IF;
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
