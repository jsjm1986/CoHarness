-- Process generations never overlap between an owner's independent Runtimes on a node.
CREATE TABLE harness.runtime_owner_generations (
  organization_id uuid NOT NULL,
  node_id uuid NOT NULL,
  owner_kind text NOT NULL CHECK(owner_kind IN ('user','project')),
  owner_id uuid NOT NULL,
  last_generation bigint NOT NULL CHECK(last_generation>=0),
  PRIMARY KEY(organization_id,node_id,owner_kind,owner_id),
  FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id) ON DELETE CASCADE
);

WITH observations AS (
  SELECT i.organization_id,i.assigned_node_id node_id,
    CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END kind,
    COALESCE(u.public_id,p.public_id) public_id,i.generation
  FROM harness.instances i
  LEFT JOIN harness.users u ON u.organization_id=i.organization_id AND u.id=i.user_id
  LEFT JOIN harness.projects p ON p.organization_id=i.organization_id AND p.id=i.project_id
  UNION ALL
  SELECT organization_id,node_id,runtime_kind,runtime_public_id,generation FROM harness.node_resource_runtimes
    WHERE runtime_kind IN ('user','project')
  UNION ALL
  SELECT organization_id,node_id,runtime_kind,runtime_public_id,generation FROM harness.desktop_session_confirmations
  UNION ALL
  SELECT n.organization_id,n.id,h.kind,h.id,h.generation
  FROM (SELECT resource_key,holder_json FROM harness.desktop_grants
    UNION ALL SELECT resource_key,holder_json FROM harness.desktop_queue) entry
  JOIN harness.desktop_resources resource ON resource.resource_key=entry.resource_key
  JOIN harness.compute_nodes n ON resource.node=n.organization_id::text || '/' || n.id::text
  CROSS JOIN LATERAL jsonb_to_record(entry.holder_json->'runtime') h(kind text,id bigint,generation bigint)
  WHERE h.kind IN ('user','project') AND h.id>0 AND h.generation>=0
), owners AS (
  SELECT v.organization_id,v.node_id,v.kind,COALESCE(u.id,p.id) owner_id,max(v.generation) generation
  FROM observations v
  LEFT JOIN harness.users u ON v.kind='user' AND u.organization_id=v.organization_id AND u.public_id=v.public_id
  LEFT JOIN harness.projects p ON v.kind='project' AND p.organization_id=v.organization_id AND p.public_id=v.public_id
  WHERE COALESCE(u.id,p.id) IS NOT NULL GROUP BY v.organization_id,v.node_id,v.kind,COALESCE(u.id,p.id)
)
INSERT INTO harness.runtime_owner_generations(organization_id,node_id,owner_kind,owner_id,last_generation)
  SELECT organization_id,node_id,kind,owner_id,generation FROM owners;

CREATE FUNCTION harness.assign_runtime_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocated bigint;
DECLARE starting boolean;
BEGIN
  starting:=NEW.desired_state='running' AND NEW.observed_state='starting';
  IF TG_OP='UPDATE' THEN starting:=starting AND NEW.generation IS DISTINCT FROM OLD.generation; END IF;
  INSERT INTO harness.runtime_owner_generations(organization_id,node_id,owner_kind,owner_id,last_generation)
    VALUES(NEW.organization_id,NEW.assigned_node_id,CASE WHEN NEW.user_id IS NULL THEN 'project' ELSE 'user' END,
      COALESCE(NEW.user_id,NEW.project_id),NEW.generation)
    ON CONFLICT(organization_id,node_id,owner_kind,owner_id) DO UPDATE SET
      last_generation=GREATEST(harness.runtime_owner_generations.last_generation+CASE WHEN starting THEN 1 ELSE 0 END,excluded.last_generation)
    RETURNING last_generation INTO allocated;
  IF starting THEN NEW.generation:=allocated; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER next_runtime_generation BEFORE INSERT OR UPDATE OF generation,assigned_node_id,desired_state,observed_state ON harness.instances
  FOR EACH ROW EXECUTE FUNCTION harness.assign_runtime_generation();

ALTER TABLE harness.node_resource_runtimes ADD COLUMN runtime_id uuid;
-- The pre-allocation model has one supervisor namespace per owner on a node.
UPDATE harness.node_resource_runtimes r SET runtime_id=i.runtime_id
  FROM harness.instances i
  LEFT JOIN harness.users u ON u.id=i.user_id AND u.organization_id=i.organization_id
  LEFT JOIN harness.projects p ON p.id=i.project_id AND p.organization_id=i.organization_id
  WHERE r.organization_id=i.organization_id AND r.node_id=i.assigned_node_id
    AND r.runtime_kind=CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END
    AND r.runtime_public_id=COALESCE(u.public_id,p.public_id);
ALTER TABLE harness.node_resource_runtimes
  ADD CONSTRAINT node_resource_runtime_environment FOREIGN KEY(runtime_id,organization_id)
    REFERENCES harness.runtime_environments(id,organization_id),
  ADD CONSTRAINT node_resource_runtime_identity CHECK((runtime_kind='gateway')=(runtime_id IS NULL)) NOT VALID;
CREATE INDEX node_resource_runtime_generations ON harness.node_resource_runtimes(organization_id,node_id,runtime_id,generation);
