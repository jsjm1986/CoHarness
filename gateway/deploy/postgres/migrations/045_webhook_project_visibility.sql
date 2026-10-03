ALTER TABLE harness.webhook_endpoints
  ADD COLUMN project_visibility text NOT NULL DEFAULT 'project'
  CHECK (project_visibility IN ('project', 'private'));
