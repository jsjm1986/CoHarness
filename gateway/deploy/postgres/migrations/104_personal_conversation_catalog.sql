ALTER TABLE harness.runtime_workspace_catalog ADD COLUMN conversations jsonb
  CHECK (conversations IS NULL OR jsonb_typeof(conversations)='array');
