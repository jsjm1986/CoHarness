-- Durable filesystem cleanup tasks created by conversation-tree purges. The
-- archive tombstone remains authoritative even when the local path is
-- temporarily unavailable; a short lease makes a crashed worker retryable.
CREATE TABLE harness.conversation_archive_file_cleanup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  root_session_id text NOT NULL,
  local_path text NOT NULL CHECK (char_length(local_path) BETWEEN 1 AND 4096),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, root_session_id, local_path),
  FOREIGN KEY (organization_id, root_session_id)
    REFERENCES harness.conversation_archive_records(organization_id, root_session_id)
    ON DELETE CASCADE
);

CREATE INDEX conversation_archive_file_cleanup_due
  ON harness.conversation_archive_file_cleanup(organization_id, next_attempt_at, lease_until, created_at);

-- Cleanup checks whether a path is still referenced by another content row;
-- keep that ownership test index-backed for large organizations.
CREATE INDEX content_files_organization_path
  ON harness.content_files(organization_id, local_path);
