-- The observed plugin composition of a content-placed project, mirroring harness.plugin_inventory.
CREATE TABLE node_content.plugin_inventory (
  organization_id uuid NOT NULL,project_id uuid NOT NULL,runtime_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,runtime_id),
  FOREIGN KEY(organization_id,runtime_id,project_id) REFERENCES node_content.spaces(organization_id,runtime_id,project_id)
);
