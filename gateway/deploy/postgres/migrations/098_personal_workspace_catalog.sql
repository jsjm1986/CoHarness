CREATE TABLE harness.runtime_workspace_catalog (
  organization_id uuid NOT NULL,
  runtime_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation>=0),
  revision bigint NOT NULL CHECK (revision>0),
  items jsonb NOT NULL CHECK (jsonb_typeof(items)='array'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,runtime_id),
  FOREIGN KEY (runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id) ON DELETE CASCADE
);
