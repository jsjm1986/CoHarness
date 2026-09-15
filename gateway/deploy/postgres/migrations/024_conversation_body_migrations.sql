-- Preserved bodies and receipts for session format migrations.
-- A body migration atomically replaces a session's event rows; the committed
-- predecessor generation is copied here first so the rewrite stays
-- recoverable, mirroring the file backend's retained-generation rule.

CREATE TABLE harness.conversation_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL REFERENCES harness.conversation_sessions(id) ON DELETE CASCADE,
  migration_id text NOT NULL,
  from_format_version integer NOT NULL,
  to_format_version integer NOT NULL,
  source_revision text NOT NULL,
  event_count bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, migration_id)
);

CREATE TABLE harness.conversation_migrated_events (
  migration_id uuid NOT NULL REFERENCES harness.conversation_migrations(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  seq bigint NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  event jsonb NOT NULL,
  payload_bytes bigint NOT NULL,
  PRIMARY KEY (migration_id, seq)
);
