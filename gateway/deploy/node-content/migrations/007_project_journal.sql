-- Digest prose, prompts, replies and visibility receipts belong to their project's volume.
CREATE TABLE node_content.project_journal (
  organization_id uuid NOT NULL ,
  project_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('current','period')),
  -- ISO week key (YYYY-Www) for period rows; NULL on the rolling current row.
  period_key text,
  -- Structured journal payload: { summary, sections: { decided, done, doing, blocked } };
  -- each item carries { text, actor?, sessionId?, sessionTitle?, seq? }.
  content json NOT NULL,
  invalidated_at timestamptz,
  activity_count integer NOT NULL DEFAULT 0,
  period_start timestamptz,
  period_end timestamptz,
  -- Resolved route that produced this entry: 'provider/model'.
  model text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,project_id) REFERENCES node_content.spaces(organization_id,project_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX project_journal_current ON node_content.project_journal(organization_id,project_id) WHERE kind='current';
CREATE UNIQUE INDEX project_journal_period ON node_content.project_journal(organization_id,project_id,period_key) WHERE kind='period';
CREATE INDEX project_journal_periods ON node_content.project_journal(organization_id,project_id,generated_at DESC) WHERE kind='period';

-- Per-project digest state. The watermark keys off the shared-visible activity
-- stream; an interrupted or failed pass leaves it uncommitted so the same rows
-- re-enter the next pass's material. `generating_since` is the in-flight lease
-- recovered after a fixed timeout so a crashed run cannot wedge the project.
CREATE TABLE node_content.project_journal_state (
  organization_id uuid NOT NULL,
  project_id uuid PRIMARY KEY,
  watermark_ts timestamptz,
  watermark_session text,
  watermark_seq bigint,watermark_runtime_namespace text,generation_id uuid,
  last_run_at timestamptz,
  generating_since timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,project_id) REFERENCES node_content.spaces(organization_id,project_id) ON DELETE CASCADE
);
CREATE TABLE node_content.project_journal_requests (
  organization_id uuid NOT NULL,
  node_id uuid NOT NULL,
  project_id uuid NOT NULL,
  project_public_id bigint NOT NULL CHECK (project_public_id>0),
  request_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE,
  actor_public_id bigint NOT NULL CHECK (actor_public_id>=0),
  occurred_at timestamptz NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  credential_source text NOT NULL CHECK (credential_source IN ('organization','project')),
  request json NOT NULL,request_session json,
  response text,
  completed boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'missing-usage' CHECK (status IN ('succeeded','failed','cancelled','missing-usage','denied')),
  input_tokens bigint CHECK (input_tokens>=0),
  output_tokens bigint CHECK (output_tokens>=0),
  cache_read_tokens bigint CHECK (cache_read_tokens>=0),
  cache_write_tokens bigint CHECK (cache_write_tokens>=0),
  delivered_at timestamptz,
  FOREIGN KEY (organization_id,project_id) REFERENCES node_content.spaces(organization_id,project_id)
);
CREATE INDEX project_journal_request_delivery ON node_content.project_journal_requests(organization_id,node_id,occurred_at,request_id)
  WHERE delivered_at IS NULL;
CREATE TABLE node_content.project_journal_materials (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  runtime_id uuid NOT NULL,runtime_namespace text GENERATED ALWAYS AS(runtime_id::text) STORED,session_id text NOT NULL,
  entry_id text NOT NULL,
  receipt bytea NOT NULL CHECK (receipt=pg_catalog.sha256(
    pg_catalog.convert_to(session_id,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(entry_id,'UTF8'))),
  PRIMARY KEY (organization_id,project_id,runtime_namespace,receipt),
  FOREIGN KEY (organization_id,project_id) REFERENCES node_content.spaces(organization_id,project_id) ON DELETE CASCADE
);
CREATE OR REPLACE FUNCTION node_content.invalidate_project_journal_sources() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_project uuid;
  new_project uuid;
BEGIN
  IF OLD.id=OLD.root_session_id AND OLD.visibility='project' AND OLD.status<>'deleted' THEN
    old_project := OLD.project_id;
  END IF;
  IF TG_OP='UPDATE' AND NEW.id=NEW.root_session_id AND NEW.visibility='project' AND NEW.status<>'deleted' THEN
    new_project := NEW.project_id;
  END IF;
  IF old_project IS NOT DISTINCT FROM new_project THEN RETURN NULL; END IF;
  UPDATE node_content.project_journal_state SET watermark_ts=NULL,watermark_session=NULL,watermark_seq=NULL,
    generating_since=NULL,generation_id=NULL,last_run_at=NULL,last_error=NULL,updated_at=now()
    WHERE organization_id=OLD.organization_id AND project_id IN (old_project,new_project);
  UPDATE node_content.project_journal SET invalidated_at=now(),updated_at=now()
    WHERE organization_id=OLD.organization_id AND project_id IN (old_project,new_project) AND invalidated_at IS NULL;
  DELETE FROM node_content.project_journal_materials
    WHERE organization_id=OLD.organization_id AND project_id IN (old_project,new_project);
  RETURN NULL;
END;
$$;
CREATE TRIGGER project_journal_source_visibility AFTER UPDATE OF visibility,status,project_id,root_session_id OR DELETE ON node_content.conversation_sessions
  FOR EACH ROW EXECUTE FUNCTION node_content.invalidate_project_journal_sources();
CREATE FUNCTION node_content.project_journal_session_identity(artifact json, request_id uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (jsonb_typeof(value)='object' AND jsonb_typeof(value->'header')='object'
    AND value->'header'->>'id'=request_id::text AND jsonb_typeof(value->'header'->'version')='number'
    AND value->>'inheritedEventCount'='0' AND jsonb_typeof(value->'events')='array') IS TRUE
  FROM (SELECT replace(artifact::text,'\u0000','\u0020')::jsonb value) parsed
$$;
ALTER TABLE node_content.project_journal_requests ADD CONSTRAINT project_journal_request_session_identity CHECK (
  request_session IS NULL OR node_content.project_journal_session_identity(request_session,request_id));
CREATE OR REPLACE FUNCTION node_content.preserve_project_journal_request_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.request_session IS NOT NULL AND NEW.request_session::text IS DISTINCT FROM OLD.request_session::text THEN
    RAISE EXCEPTION 'committed progress request Session is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_project_journal_request_session BEFORE UPDATE OF request_session ON node_content.project_journal_requests
  FOR EACH ROW EXECUTE FUNCTION node_content.preserve_project_journal_request_session();
