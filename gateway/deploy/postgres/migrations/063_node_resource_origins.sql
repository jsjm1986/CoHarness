ALTER TABLE harness.node_resource_requests
  ADD COLUMN origin_kind text CHECK (origin_kind IN ('runtime','principal','session')),
  ADD COLUMN scope_id uuid,
  ADD COLUMN principal_admin boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT node_resource_origin_session CHECK (
    origin_kind IS NULL OR (origin_kind='session')=(session_id IS NOT NULL)
  ),
  ADD CONSTRAINT node_resource_origin_scope CHECK (scope_id IS NULL OR (origin_kind IS NOT NULL AND origin_kind='session')),
  ADD CONSTRAINT node_resource_origin_admin CHECK (NOT principal_admin OR (origin_kind IS NOT NULL AND origin_kind='principal'));
