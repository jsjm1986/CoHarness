-- Human-facing project progress journal. The Gateway progress digest reads
-- shared-visible member activity (the same source the project activity feed
-- serves, restricted to project-visible conversations) and writes synthesized
-- period entries so members can catch up without reading the chat history.
-- Entries are generated content, never member-authored activity; agent-facing
-- memory lives in a separate runtime-owned domain and does not read this one.

CREATE TABLE harness.project_journal (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('current','period')),
  -- ISO week key (YYYY-Www) for period rows; NULL on the rolling current row.
  period_key text,
  -- Structured journal payload: { summary, sections: { decided, done, doing, blocked } };
  -- each item carries { text, actor?, sessionId?, sessionTitle?, seq? }.
  content jsonb NOT NULL,
  activity_count integer NOT NULL DEFAULT 0,
  period_start timestamptz,
  period_end timestamptz,
  -- Resolved route that produced this entry: 'provider/model'.
  model text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,project_id) REFERENCES harness.projects(organization_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX project_journal_current ON harness.project_journal(organization_id,project_id) WHERE kind='current';
CREATE UNIQUE INDEX project_journal_period ON harness.project_journal(organization_id,project_id,period_key) WHERE kind='period';
CREATE INDEX project_journal_periods ON harness.project_journal(organization_id,project_id,generated_at DESC) WHERE kind='period';

-- Per-project digest state. The watermark keys off the shared-visible activity
-- stream; an interrupted or failed pass leaves it uncommitted so the same rows
-- re-enter the next pass's material. `generating_since` is the in-flight lease
-- recovered after a fixed timeout so a crashed run cannot wedge the project.
CREATE TABLE harness.project_journal_state (
  organization_id uuid NOT NULL,
  project_id uuid PRIMARY KEY,
  watermark_ts timestamptz,
  watermark_session text,
  watermark_seq bigint,
  last_run_at timestamptz,
  generating_since timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,project_id) REFERENCES harness.projects(organization_id,id) ON DELETE CASCADE
);
