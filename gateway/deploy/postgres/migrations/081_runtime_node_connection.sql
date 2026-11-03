ALTER TABLE harness.instances
  ADD COLUMN node_connection_id uuid,
  ADD COLUMN node_connection_epoch bigint,
  ADD CONSTRAINT runtime_node_connection_pair CHECK (
    (node_connection_id IS NULL)=(node_connection_epoch IS NULL)
    AND (node_connection_epoch IS NULL OR node_connection_epoch>0)
  );

CREATE FUNCTION harness.node_execution_available(organization uuid,node uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM harness.compute_nodes n
    JOIN harness.organizations o ON o.id=n.organization_id AND o.status='active'
    LEFT JOIN harness.node_agents a ON a.organization_id=n.organization_id AND a.node_id=n.id
    WHERE n.organization_id=organization AND n.id=node AND n.status='active'
      AND (a.node_id IS NULL OR (a.revoked_at IS NULL AND a.credential_hash IS NOT NULL
        AND a.connection_id IS NOT NULL AND a.lease_expires_at>clock_timestamp())))
$$;

CREATE FUNCTION harness.runtime_node_execution_allowed(organization uuid,node uuid,connection uuid,epoch bigint)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT harness.node_execution_available(organization,node)
    AND ((connection IS NULL AND epoch IS NULL AND NOT EXISTS(SELECT 1 FROM harness.node_agents a
      WHERE a.organization_id=organization AND a.node_id=node))
      OR EXISTS(SELECT 1 FROM harness.node_agents a WHERE a.organization_id=organization AND a.node_id=node
        AND a.connection_id=connection AND a.connection_epoch=epoch))
$$;

-- A connection successor never inherits a previously issued Runtime credential.
CREATE FUNCTION harness.bind_runtime_node_connection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE agent harness.node_agents%ROWTYPE;
BEGIN
  IF NEW.observed_state<>'starting' OR NEW.desired_state<>'running' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.generation=OLD.generation THEN RETURN NEW; END IF;
  PERFORM 1 FROM harness.compute_nodes n
    JOIN harness.organizations o ON o.id=n.organization_id AND o.status='active'
    WHERE n.organization_id=NEW.organization_id AND n.id=NEW.assigned_node_id AND n.status='active'
    FOR SHARE OF n,o;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime computer is unavailable' USING ERRCODE='55000',CONSTRAINT='runtime_node_execution';
  END IF;
  SELECT * INTO agent FROM harness.node_agents a
    WHERE a.organization_id=NEW.organization_id AND a.node_id=NEW.assigned_node_id FOR SHARE;
  IF FOUND THEN
    IF agent.revoked_at IS NOT NULL OR agent.credential_hash IS NULL OR agent.connection_id IS NULL
      OR agent.lease_expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'runtime computer connection is unavailable' USING ERRCODE='55000',CONSTRAINT='runtime_node_execution';
    END IF;
    NEW.node_connection_id:=agent.connection_id;
    NEW.node_connection_epoch:=agent.connection_epoch;
  ELSE
    NEW.node_connection_id:=NULL;
    NEW.node_connection_epoch:=NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bind_runtime_node_connection BEFORE INSERT OR UPDATE ON harness.instances
  FOR EACH ROW EXECUTE FUNCTION harness.bind_runtime_node_connection();

CREATE FUNCTION harness.capture_node_connection_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.credential_hash IS DISTINCT FROM OLD.credential_hash
    OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.connection_epoch IS DISTINCT FROM OLD.connection_epoch
    OR (NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at AND NEW.lease_expires_at<=clock_timestamp()) THEN
    PERFORM harness.invalidate_access(NEW.organization_id,jsonb_build_object('nodeId',NEW.node_id));
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER node_connection_access_changes AFTER UPDATE ON harness.node_agents
  FOR EACH ROW EXECUTE FUNCTION harness.capture_node_connection_change();
