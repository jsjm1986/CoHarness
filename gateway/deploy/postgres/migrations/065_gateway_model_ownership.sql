-- Gateway HTTP model requests share node scheduling, but never inherit a Runtime's process ownership.
ALTER TABLE harness.node_resource_runtimes DROP CONSTRAINT node_resource_runtimes_runtime_kind_check;
ALTER TABLE harness.node_resource_runtimes ADD CONSTRAINT node_resource_runtimes_runtime_kind_check
  CHECK (runtime_kind IN ('user','project','gateway'));

CREATE TABLE harness.node_resource_gateways (
  organization_id uuid NOT NULL,
  node_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  generation bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device text NOT NULL,
  inode text NOT NULL,
  UNIQUE (organization_id,node_id,owner_id),
  FOREIGN KEY (organization_id,node_id) REFERENCES harness.node_resource_state(organization_id,node_id)
);
