ALTER TABLE harness.users ADD COLUMN personal_runtime_allocation text NOT NULL DEFAULT 'automatic'
  CHECK(personal_runtime_allocation IN ('automatic','managed'));

CREATE TABLE harness.runtime_allocation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  user_id uuid,
  max_total integer NOT NULL DEFAULT 8 CHECK(max_total>0),
  max_per_node integer NOT NULL DEFAULT 4 CHECK(max_per_node>0 AND max_per_node<=max_total),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  FOREIGN KEY(user_id,organization_id) REFERENCES harness.users(id,organization_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX runtime_allocation_organization_policy ON harness.runtime_allocation_policies(organization_id) WHERE user_id IS NULL;
CREATE UNIQUE INDEX runtime_allocation_user_policy ON harness.runtime_allocation_policies(organization_id,user_id) WHERE user_id IS NOT NULL;
INSERT INTO harness.runtime_allocation_policies(organization_id) SELECT id FROM harness.organizations;
CREATE FUNCTION harness.initialize_runtime_allocation_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO harness.runtime_allocation_policies(organization_id) VALUES(NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER initialize_runtime_allocation_policy AFTER INSERT ON harness.organizations
  FOR EACH ROW EXECUTE FUNCTION harness.initialize_runtime_allocation_policy();

CREATE TABLE harness.runtime_allocation_receipts (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  runtime_id uuid NOT NULL,
  node_id uuid NOT NULL,
  user_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,request_id),
  UNIQUE(organization_id,runtime_id),
  FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
  FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
  FOREIGN KEY(user_id,organization_id) REFERENCES harness.users(id,organization_id),
  FOREIGN KEY(actor_user_id,organization_id) REFERENCES harness.users(id,organization_id)
);
