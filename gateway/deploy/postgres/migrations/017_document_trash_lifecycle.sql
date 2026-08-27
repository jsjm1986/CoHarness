-- Document catalog lifecycle mirrors the runtime recycle bin.  Runtime bytes
-- stay in the provider-owned trash while the recovery window is open; the
-- catalog keeps metadata and audit history after a permanent purge.

ALTER TABLE harness.document_catalog
  DROP CONSTRAINT IF EXISTS document_catalog_state_check;

ALTER TABLE harness.document_catalog
  ADD COLUMN IF NOT EXISTS trashed_at timestamptz,
  ADD COLUMN IF NOT EXISTS trashed_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS restored_at timestamptz,
  ADD COLUMN IF NOT EXISTS restored_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS purge_after timestamptz,
  ADD COLUMN IF NOT EXISTS purged_at timestamptz,
  ADD COLUMN IF NOT EXISTS purged_by_user_id uuid;

UPDATE harness.document_catalog
SET state='trash',
    trashed_at=COALESCE(trashed_at, deleted_at, updated_at, now()),
    purge_after=COALESCE(purge_after, COALESCE(deleted_at, updated_at, now()) + interval '30 days')
WHERE state='deleted';

ALTER TABLE harness.document_catalog
  ADD CONSTRAINT document_catalog_state_check CHECK (state IN ('active','trash','purged'));

ALTER TABLE harness.document_catalog
  ADD CONSTRAINT document_catalog_trashed_by_fk FOREIGN KEY (trashed_by_user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE SET NULL (trashed_by_user_id),
  ADD CONSTRAINT document_catalog_restored_by_fk FOREIGN KEY (restored_by_user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE SET NULL (restored_by_user_id),
  ADD CONSTRAINT document_catalog_purged_by_fk FOREIGN KEY (purged_by_user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE SET NULL (purged_by_user_id);

CREATE INDEX document_catalog_trash_purge
  ON harness.document_catalog(organization_id, purge_after, id)
  WHERE state='trash' AND purge_after IS NOT NULL;

ALTER TABLE harness.document_history
  DROP CONSTRAINT IF EXISTS document_history_event_kind_check;
ALTER TABLE harness.document_history
  ADD CONSTRAINT document_history_event_kind_check CHECK (event_kind IN (
    'created','updated','copied-in','copied-out','deleted','restored',
    'purged','ownership-transferred','denied'
  ));
