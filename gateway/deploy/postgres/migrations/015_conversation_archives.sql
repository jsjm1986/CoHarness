-- Organization-wide archive lifecycle metadata.  Conversation transcripts may
-- remain in a personal runtime, so the archive index deliberately does not
-- require a foreign key to conversation_sessions.
CREATE TABLE harness.conversation_archive_records (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  root_session_id text NOT NULL,
  runtime_kind text NOT NULL CHECK (runtime_kind IN ('user','project')),
  runtime_public_id bigint NOT NULL CHECK (runtime_public_id > 0),
  project_id uuid,
  creator_user_id uuid,
  title text,
  workspace_path text,
  workspace_title text,
  workspace_position integer CHECK (workspace_position IS NULL OR workspace_position >= 0),
  message_count bigint NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  state text NOT NULL DEFAULT 'archived' CHECK (state IN ('archived','trash','purged')),
  archived_at timestamptz NOT NULL DEFAULT now(),
  archived_by_user_id uuid,
  restored_at timestamptz,
  restored_by_user_id uuid,
  trashed_at timestamptz,
  trashed_by_user_id uuid,
  purge_after timestamptz,
  sync_revision bigint NOT NULL DEFAULT 0 CHECK (sync_revision >= 0),
  sync_state text NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending','synced','conflict','unavailable')),
  last_sync_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, root_session_id),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES harness.projects(id, organization_id) ON DELETE SET NULL,
  FOREIGN KEY (creator_user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE SET NULL,
  FOREIGN KEY (archived_by_user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE SET NULL,
  FOREIGN KEY (restored_by_user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE SET NULL,
  FOREIGN KEY (trashed_by_user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE SET NULL
);

CREATE INDEX conversation_archive_records_state_time
  ON harness.conversation_archive_records(organization_id, state, archived_at DESC, root_session_id);
CREATE INDEX conversation_archive_records_user_time
  ON harness.conversation_archive_records(organization_id, creator_user_id, archived_at DESC);
CREATE INDEX conversation_archive_records_project_time
  ON harness.conversation_archive_records(organization_id, project_id, archived_at DESC);
CREATE INDEX conversation_archive_records_purge
  ON harness.conversation_archive_records(purge_after)
  WHERE state = 'trash' AND purge_after IS NOT NULL;

-- Searchable text synchronized from personal runtimes.  Project conversations
-- reuse conversation_search and are queried through the same archive root.
CREATE TABLE harness.conversation_archive_search (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  root_session_id text NOT NULL,
  session_id text NOT NULL,
  event_seq bigint NOT NULL CHECK (event_seq >= 0),
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, session_id, event_seq),
  FOREIGN KEY (organization_id, root_session_id)
    REFERENCES harness.conversation_archive_records(organization_id, root_session_id)
    ON DELETE CASCADE
);
CREATE INDEX conversation_archive_search_trgm
  ON harness.conversation_archive_search USING gin (content gin_trgm_ops);
CREATE INDEX conversation_archive_search_root_time
  ON harness.conversation_archive_search(organization_id, root_session_id, occurred_at DESC);

-- Desired lifecycle mutations are durable until the owning runtime reports an
-- acknowledgement.  This is also the retry ledger for offline runtimes.
CREATE TABLE harness.conversation_archive_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  root_session_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('restore','trash','purge')),
  requested_by_user_id uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  desired_revision bigint NOT NULL CHECK (desired_revision >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','failed')),
  error text,
  applied_at timestamptz,
  idempotency_key text,
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, root_session_id)
    REFERENCES harness.conversation_archive_records(organization_id, root_session_id)
    ON DELETE CASCADE,
  FOREIGN KEY (requested_by_user_id, organization_id)
    REFERENCES harness.users(id, organization_id)
);
CREATE INDEX conversation_archive_commands_pending
  ON harness.conversation_archive_commands(organization_id, root_session_id, requested_at)
  WHERE status = 'pending';
