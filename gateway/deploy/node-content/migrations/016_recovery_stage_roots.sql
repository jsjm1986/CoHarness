-- A target may release only the directory objects reserved by its own interrupted recovery.
CREATE TABLE node_content.recovery_stage_roots (
  id uuid PRIMARY KEY, operation_id uuid NOT NULL, organization_id uuid NOT NULL, project_id uuid NOT NULL,
  runtime_id uuid NOT NULL, node_id uuid NOT NULL, volume_id uuid NOT NULL, role text NOT NULL
    CHECK(role IN ('workspace','runtime','userdoc-metadata','userdoc-files')),
  root_path text NOT NULL, temporary_path text NOT NULL, retained_path text NOT NULL,
  parent_device text NOT NULL, parent_inode text NOT NULL, device text NOT NULL, inode text NOT NULL,
  withdrawn_at timestamptz
);
CREATE UNIQUE INDEX recovery_live_root ON node_content.recovery_stage_roots(operation_id,role) WHERE withdrawn_at IS NULL;
