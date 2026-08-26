-- Session lifecycle metadata is kept beside the event log so cold listings do
-- not have to guess blankness from a partial projection or parse every log.
ALTER TABLE harness.conversation_sessions
  ADD COLUMN draft boolean NOT NULL DEFAULT false,
  ADD COLUMN has_visible_content boolean NOT NULL DEFAULT false,
  ADD COLUMN visible_content_seq bigint,
  ADD COLUMN last_prompt_at timestamptz;

-- Rebuild the facts for rows written before this migration. The event JSON is
-- the source of truth; empty assistant usage records and empty message arrays
-- remain blank. PostgreSQL `json` accepts escaped NUL characters, but JSON
-- operators reject them while decoding a value. Such rows are conservatively
-- treated as visible content (and as a prompt for user messages), so a legacy
-- message containing NUL cannot disappear from a cold listing.
WITH event_facts AS (
  SELECT
    e.session_id,
    e.seq,
    e.occurred_at,
    CASE
      WHEN position(chr(92) || 'u0000' IN e.event::text) > 0
        THEN e.event_type IN ('user/message', 'assistant/message', 'tool/result')
      WHEN e.event_type = 'user/message'
        THEN CASE WHEN json_typeof(e.event->'data'->'content') = 'array'
          THEN json_array_length(e.event->'data'->'content') > 0 ELSE false END
      WHEN e.event_type IN ('assistant/message', 'tool/result')
        THEN CASE WHEN json_typeof(e.event->'data'->'message'->'content') = 'array'
          THEN json_array_length(e.event->'data'->'message'->'content') > 0 ELSE false END
      ELSE false
    END AS has_visible_content,
    CASE
      WHEN position(chr(92) || 'u0000' IN e.event::text) > 0
        THEN e.event_type = 'user/message'
      ELSE e.event_type = 'user/message' AND e.event->'data'->'source'->>'kind' = 'user'
    END AS is_user_prompt
  FROM harness.conversation_events AS e
)
UPDATE harness.conversation_sessions AS s
SET has_visible_content = EXISTS (
      SELECT 1 FROM event_facts AS e
      WHERE e.session_id = s.id AND e.has_visible_content
    ),
    visible_content_seq = (
      SELECT max(e.seq) FROM event_facts AS e
      WHERE e.session_id = s.id AND e.has_visible_content
    ),
    last_prompt_at = (
      SELECT max(e.occurred_at) FROM event_facts AS e
      WHERE e.session_id = s.id AND e.is_user_prompt
    );

ALTER TABLE harness.conversation_sessions
  ADD CONSTRAINT conversation_sessions_visible_content_seq_check
    CHECK (visible_content_seq IS NULL OR visible_content_seq >= 0);

CREATE INDEX conversation_sessions_visible_content
  ON harness.conversation_sessions(organization_id, has_visible_content, updated_at DESC)
  WHERE status <> 'deleted';

-- A draft reservation is an expiring, scope-qualified claim for a browser
-- draft.  It never contains prompt text or credentials.  The session id is
-- canonical for all retries carrying the same draft id and scope key.
CREATE TABLE harness.conversation_draft_reservations (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  draft_id text NOT NULL,
  session_id text NOT NULL,
  user_id uuid,
  project_id uuid,
  cwd text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('personal','project','private')),
  agent_preset text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, scope_key, draft_id),
  UNIQUE (organization_id, session_id),
  CHECK (user_id IS NOT NULL OR project_id IS NOT NULL),
  CHECK ((project_id IS NULL AND visibility = 'personal')
    OR (project_id IS NOT NULL AND visibility IN ('project','private'))),
  FOREIGN KEY (user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, organization_id)
    REFERENCES harness.projects(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX conversation_draft_reservations_expiry
  ON harness.conversation_draft_reservations(lease_expires_at);
CREATE INDEX conversation_draft_reservations_session
  ON harness.conversation_draft_reservations(organization_id, session_id);

-- Existing archive rows represent durable conversations.  Empty drafts are a
-- separate maintenance-only kind so ordinary archive views never show them.
ALTER TABLE harness.conversation_archive_records
  ADD COLUMN record_kind text NOT NULL DEFAULT 'conversation'
    CHECK (record_kind IN ('conversation','empty-draft'));
CREATE INDEX conversation_archive_records_kind_state
  ON harness.conversation_archive_records(organization_id, record_kind, state, archived_at DESC);
