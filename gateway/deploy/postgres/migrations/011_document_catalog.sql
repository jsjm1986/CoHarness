-- Organization-level metadata catalog for user and project documents.
-- File bytes remain in the runtime-owned document roots.  The catalog stores
-- opaque references, ownership, lineage, and an append-only operation trail.

CREATE TABLE harness.document_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  scope_kind text NOT NULL CHECK (scope_kind IN ('personal','project')),
  scope_user_id uuid,
  scope_project_id uuid,
  runtime_doc_id text NOT NULL,
  directory_id text NOT NULL DEFAULT '',
  name text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes >= 0),
  media_type text NOT NULL,
  modified_at_ms bigint NOT NULL CHECK (modified_at_ms >= 0),
  owner_user_id uuid,
  owner_source text NOT NULL DEFAULT 'legacy'
    CHECK (owner_source IN ('upload','transfer','legacy','admin')),
  lineage_root_id uuid,
  source_catalog_id uuid,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','deleted')),
  legacy boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  FOREIGN KEY (scope_user_id, organization_id) REFERENCES harness.users(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (scope_project_id, organization_id) REFERENCES harness.projects(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id) REFERENCES harness.users(id) ON DELETE SET NULL,
  FOREIGN KEY (lineage_root_id) REFERENCES harness.document_catalog(id) ON DELETE SET NULL,
  FOREIGN KEY (source_catalog_id) REFERENCES harness.document_catalog(id) ON DELETE SET NULL,
  CHECK (
    (scope_kind = 'personal' AND scope_user_id IS NOT NULL AND scope_project_id IS NULL)
    OR (scope_kind = 'project' AND scope_user_id IS NULL AND scope_project_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX document_catalog_personal_key
  ON harness.document_catalog(organization_id, scope_user_id, runtime_doc_id)
  WHERE scope_kind='personal';
CREATE UNIQUE INDEX document_catalog_project_key
  ON harness.document_catalog(organization_id, scope_project_id, runtime_doc_id)
  WHERE scope_kind='project';
CREATE INDEX document_catalog_scope_time
  ON harness.document_catalog(organization_id, scope_kind, scope_project_id, scope_user_id, updated_at DESC)
  WHERE state='active';
CREATE INDEX document_catalog_owner
  ON harness.document_catalog(organization_id, owner_user_id)
  WHERE state='active';
CREATE INDEX document_catalog_lineage
  ON harness.document_catalog(organization_id, lineage_root_id, updated_at DESC);

CREATE TABLE harness.document_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  actor_user_id uuid,
  operation_kind text NOT NULL CHECK (operation_kind IN (
    'copy','retry','reconcile','delete','ownership-transfer','admin-action'
  )),
  source_scope_kind text CHECK (source_scope_kind IN ('personal','project')),
  source_user_id uuid,
  source_project_id uuid,
  target_scope_kind text CHECK (target_scope_kind IN ('personal','project')),
  target_user_id uuid,
  target_project_id uuid,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','partial','failed')),
  requested_count integer NOT NULL DEFAULT 0 CHECK (requested_count >= 0),
  completed_count integer NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (source_user_id) REFERENCES harness.users(id) ON DELETE SET NULL,
  FOREIGN KEY (source_project_id) REFERENCES harness.projects(id) ON DELETE SET NULL,
  FOREIGN KEY (target_user_id) REFERENCES harness.users(id) ON DELETE SET NULL,
  FOREIGN KEY (target_project_id) REFERENCES harness.projects(id) ON DELETE SET NULL,
  FOREIGN KEY (actor_user_id) REFERENCES harness.users(id) ON DELETE SET NULL
);
CREATE INDEX document_operations_actor_time
  ON harness.document_operations(organization_id, actor_user_id, created_at DESC);
CREATE INDEX document_operations_time
  ON harness.document_operations(organization_id, created_at DESC);

CREATE TABLE harness.document_operation_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL REFERENCES harness.document_operations(id) ON DELETE CASCADE,
  source_catalog_id uuid REFERENCES harness.document_catalog(id) ON DELETE SET NULL,
  target_catalog_id uuid REFERENCES harness.document_catalog(id) ON DELETE SET NULL,
  source_runtime_doc_id text NOT NULL,
  source_name text NOT NULL,
  target_runtime_doc_id text,
  status text NOT NULL CHECK (status IN ('pending','copied','failed')),
  error_code text,
  error_message text,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_operation_items_operation
  ON harness.document_operation_items(organization_id, operation_id, id);
CREATE INDEX document_operation_items_catalog
  ON harness.document_operation_items(organization_id, source_catalog_id, target_catalog_id, created_at DESC);

CREATE TABLE harness.document_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  catalog_id uuid REFERENCES harness.document_catalog(id) ON DELETE SET NULL,
  operation_id uuid REFERENCES harness.document_operations(id) ON DELETE SET NULL,
  actor_user_id uuid,
  event_kind text NOT NULL CHECK (event_kind IN (
    'created','updated','copied-in','copied-out','deleted','restored','ownership-transferred','denied'
  )),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (actor_user_id) REFERENCES harness.users(id) ON DELETE SET NULL
);
CREATE INDEX document_history_catalog_time
  ON harness.document_history(organization_id, catalog_id, created_at DESC);
CREATE INDEX document_history_time
  ON harness.document_history(organization_id, created_at DESC);
