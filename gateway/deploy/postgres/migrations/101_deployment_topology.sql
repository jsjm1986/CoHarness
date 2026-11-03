CREATE TABLE harness.deployment_topology (
  organization_id uuid PRIMARY KEY REFERENCES harness.organizations(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  legacy_initialization_required boolean NOT NULL DEFAULT false,
  primary_node_id uuid,
  primary_origin text,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(primary_node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
  CHECK (NOT enabled OR (primary_node_id IS NOT NULL AND primary_origin IS NOT NULL))
);

INSERT INTO harness.deployment_topology(organization_id) SELECT id FROM harness.organizations;
UPDATE harness.deployment_topology t SET legacy_initialization_required=true
  WHERE EXISTS(SELECT 1 FROM harness.node_agents a WHERE a.organization_id=t.organization_id AND a.credential_hash IS NOT NULL);
CREATE FUNCTION harness.initialize_deployment_topology() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO harness.deployment_topology(organization_id) VALUES(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER initialize_deployment_topology AFTER INSERT ON harness.organizations
  FOR EACH ROW EXECUTE FUNCTION harness.initialize_deployment_topology();

ALTER TABLE harness.node_agents ADD COLUMN attachment_state text NOT NULL DEFAULT 'managed'
  CHECK (attachment_state IN ('pending','managed','detached'));
UPDATE harness.node_agents SET attachment_state='pending' WHERE credential_hash IS NULL AND revoked_at IS NULL;

CREATE FUNCTION harness.entry_node_visible(organization uuid,entry uuid,target uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT entry=target OR EXISTS(SELECT 1 FROM harness.deployment_topology topology
    JOIN harness.node_agents agent ON agent.organization_id=topology.organization_id AND agent.node_id=target
    WHERE topology.organization_id=organization AND topology.enabled AND topology.primary_node_id=entry
      AND agent.attachment_state='managed' AND agent.revoked_at IS NULL)
$$;

CREATE OR REPLACE FUNCTION harness.node_execution_available(organization uuid,node uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM harness.compute_nodes n
    JOIN harness.organizations o ON o.id=n.organization_id AND o.status='active'
    LEFT JOIN harness.node_agents a ON a.organization_id=n.organization_id AND a.node_id=n.id
    WHERE n.organization_id=organization AND n.id=node AND n.status='active'
      AND (a.node_id IS NULL OR a.attachment_state IN ('pending','detached')
        OR (a.revoked_at IS NULL AND a.credential_hash IS NOT NULL AND a.connection_id IS NOT NULL
          AND a.lease_expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM harness.deployment_topology t
            WHERE t.organization_id=organization AND (t.enabled OR t.legacy_initialization_required)))))
$$;

CREATE OR REPLACE FUNCTION harness.runtime_node_execution_allowed(organization uuid,node uuid,connection uuid,epoch bigint)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT harness.node_execution_available(organization,node)
    AND ((connection IS NULL AND epoch IS NULL AND NOT EXISTS(SELECT 1 FROM harness.node_agents a
      WHERE a.organization_id=organization AND a.node_id=node AND a.attachment_state='managed'))
      OR EXISTS(SELECT 1 FROM harness.node_agents a WHERE a.organization_id=organization AND a.node_id=node
        AND a.attachment_state='managed' AND a.connection_id=connection AND a.connection_epoch=epoch))
$$;

CREATE OR REPLACE FUNCTION harness.bind_runtime_node_connection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE agent harness.node_agents%ROWTYPE;
BEGIN
  IF NEW.observed_state<>'starting' OR NEW.desired_state<>'running' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.generation=OLD.generation THEN RETURN NEW; END IF;
  PERFORM 1 FROM harness.compute_nodes n JOIN harness.organizations o ON o.id=n.organization_id AND o.status='active'
    WHERE n.organization_id=NEW.organization_id AND n.id=NEW.assigned_node_id AND n.status='active' FOR SHARE OF n,o;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime computer is unavailable' USING ERRCODE='55000',CONSTRAINT='runtime_node_execution';
  END IF;
  SELECT * INTO agent FROM harness.node_agents a
    WHERE a.organization_id=NEW.organization_id AND a.node_id=NEW.assigned_node_id FOR SHARE;
  IF FOUND AND agent.attachment_state='managed' THEN
    IF agent.revoked_at IS NOT NULL OR agent.credential_hash IS NULL OR agent.connection_id IS NULL
      OR agent.lease_expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM harness.deployment_topology t
        WHERE t.organization_id=NEW.organization_id AND (t.enabled OR t.legacy_initialization_required)) THEN
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

CREATE FUNCTION harness.guard_node_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.attachment_state IS NOT DISTINCT FROM OLD.attachment_state
    OR (NEW.attachment_state<>'managed' AND OLD.attachment_state<>'managed') THEN RETURN NEW; END IF;
  PERFORM 1 FROM harness.instances i WHERE i.organization_id=NEW.organization_id AND i.assigned_node_id=NEW.node_id
    AND (i.observed_state<>'stopped' OR i.desired_state<>'stopped' OR i.provisioning_state<>'ready') FOR UPDATE NOWAIT;
  IF FOUND THEN
    RAISE EXCEPTION 'runtime computer is busy' USING ERRCODE='55000',CONSTRAINT='node_attachment_busy';
  END IF;
  PERFORM harness.invalidate_access(NEW.organization_id,jsonb_build_object('nodeId',NEW.node_id));
  RETURN NEW;
END $$;
CREATE TRIGGER guard_node_attachment BEFORE UPDATE OF attachment_state ON harness.node_agents
  FOR EACH ROW EXECUTE FUNCTION harness.guard_node_attachment();

CREATE FUNCTION harness.guard_deployment_topology() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.enabled AND NEW.enabled AND OLD.primary_node_id IS DISTINCT FROM NEW.primary_node_id THEN
    RAISE EXCEPTION 'disable aggregation before changing the primary computer' USING ERRCODE='55000',CONSTRAINT='deployment_primary_immutable';
  END IF;
  IF (OLD.enabled AND NOT NEW.enabled) AND EXISTS(SELECT 1 FROM harness.node_agents a
    WHERE a.organization_id=NEW.organization_id AND a.attachment_state<>'detached') THEN
    RAISE EXCEPTION 'detach computers before disabling aggregation' USING ERRCODE='55000',CONSTRAINT='deployment_computers_attached';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_deployment_topology BEFORE UPDATE OF enabled,primary_node_id ON harness.deployment_topology
  FOR EACH ROW EXECUTE FUNCTION harness.guard_deployment_topology();
