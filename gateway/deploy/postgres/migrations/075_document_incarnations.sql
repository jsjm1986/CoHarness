-- A path can be reused after a document is trashed. Catalog identity therefore
-- follows the immutable filesystem incarnation, while active paths stay unique.

ALTER TABLE harness.document_catalog
  ADD COLUMN runtime_incarnation_id uuid,
  ADD COLUMN runtime_revision bigint NOT NULL DEFAULT 1 CHECK (runtime_revision > 0),
  ADD COLUMN trash_action_id uuid,
  ADD COLUMN missing_at timestamptz;

UPDATE harness.document_catalog
SET trash_action_id=gen_random_uuid()
WHERE state='trash' AND trash_action_id IS NULL;

ALTER TABLE harness.document_catalog
  DROP CONSTRAINT IF EXISTS document_catalog_state_check;

ALTER TABLE harness.document_catalog
  ADD CONSTRAINT document_catalog_state_check CHECK (state IN ('active','trash','purged','missing')),
  ADD CONSTRAINT document_catalog_trash_action_check CHECK (state<>'trash' OR trash_action_id IS NOT NULL);

DROP INDEX IF EXISTS harness.document_catalog_personal_key;
DROP INDEX IF EXISTS harness.document_catalog_project_key;

CREATE UNIQUE INDEX document_catalog_personal_active_path_key
  ON harness.document_catalog(organization_id, scope_user_id, runtime_doc_id)
  WHERE scope_kind='personal' AND state='active';
CREATE UNIQUE INDEX document_catalog_project_active_path_key
  ON harness.document_catalog(organization_id, scope_project_id, runtime_doc_id)
  WHERE scope_kind='project' AND state='active';
CREATE UNIQUE INDEX document_catalog_personal_incarnation_key
  ON harness.document_catalog(organization_id, scope_user_id, runtime_incarnation_id)
  WHERE scope_kind='personal' AND runtime_incarnation_id IS NOT NULL;
CREATE UNIQUE INDEX document_catalog_project_incarnation_key
  ON harness.document_catalog(organization_id, scope_project_id, runtime_incarnation_id)
  WHERE scope_kind='project' AND runtime_incarnation_id IS NOT NULL;
CREATE UNIQUE INDEX document_catalog_trash_action_key
  ON harness.document_catalog(organization_id, trash_action_id)
  WHERE trash_action_id IS NOT NULL;

CREATE TABLE harness.document_projection_checkpoints (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  root_id uuid NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('personal','project')),
  scope_user_id uuid,
  scope_project_id uuid,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  ordinal integer NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,root_id),
  FOREIGN KEY (scope_user_id,organization_id) REFERENCES harness.users(id,organization_id) ON DELETE CASCADE,
  FOREIGN KEY (scope_project_id,organization_id) REFERENCES harness.projects(id,organization_id) ON DELETE CASCADE,
  CHECK ((sequence=0)=(ordinal=0)),
  CHECK (
    (scope_kind='personal' AND scope_user_id IS NOT NULL AND scope_project_id IS NULL)
    OR (scope_kind='project' AND scope_user_id IS NULL AND scope_project_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX document_projection_personal_scope_key
  ON harness.document_projection_checkpoints(organization_id,scope_user_id) WHERE scope_kind='personal';
CREATE UNIQUE INDEX document_projection_project_scope_key
  ON harness.document_projection_checkpoints(organization_id,scope_project_id) WHERE scope_kind='project';

ALTER TABLE harness.document_history
  DROP CONSTRAINT IF EXISTS document_history_event_kind_check;
ALTER TABLE harness.document_history
  ADD CONSTRAINT document_history_event_kind_check CHECK (event_kind IN (
    'created','updated','copied-in','copied-out','deleted','restored','purged',
    'ownership-transferred','denied','missing'
  ));
