CREATE TABLE node_content.workspace_catalog (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  runtime_id uuid NOT NULL,
  generation bigint NOT NULL CHECK(generation>=0),
  revision bigint NOT NULL CHECK(revision>0),
  items jsonb NOT NULL CHECK(jsonb_typeof(items)='array'),
  PRIMARY KEY(organization_id, runtime_id),
  FOREIGN KEY(organization_id,runtime_id,project_id) REFERENCES node_content.spaces(organization_id,runtime_id,project_id)
);
