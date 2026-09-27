-- Runtime-scoped metadata never grants execution authority by itself. Personal
-- transcripts remain in JSONL; project metadata is checked against PostgreSQL.
CREATE TABLE harness.execution_sessions (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  runtime_kind text NOT NULL CHECK (runtime_kind IN ('user','project')),
  runtime_public_id bigint NOT NULL CHECK (runtime_public_id > 0),
  session_id text NOT NULL CHECK (session_id <> ''),
  parent_session_id text,
  is_seeded boolean NOT NULL DEFAULT false,
  actor_witnesses jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(actor_witnesses)='object'),
  primary_actor_user_id uuid REFERENCES harness.users(id),
  unverified_history boolean NOT NULL DEFAULT false,
  inheritance_hash text CHECK (inheritance_hash ~ '^[0-9a-f]{64}$'),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,runtime_kind,runtime_public_id,session_id),
  CHECK (parent_session_id IS NULL OR parent_session_id <> session_id),
  FOREIGN KEY (organization_id,runtime_kind,runtime_public_id,parent_session_id)
    REFERENCES harness.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id)
);

-- These records prove who supplied one exact input. Eligibility is checked from
-- current account and Session ACL rows whenever a capability is requested.
CREATE TABLE harness.execution_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  runtime_kind text NOT NULL CHECK (runtime_kind IN ('user','project')),
  runtime_public_id bigint NOT NULL CHECK (runtime_public_id > 0),
  session_id text NOT NULL,
  message_id text NOT NULL CHECK (message_id <> ''),
  kind text NOT NULL CHECK (kind IN ('message','question')),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id uuid NOT NULL,
  actor_user_ids uuid[] NOT NULL CHECK (cardinality(actor_user_ids) > 0),
  previous_input_id uuid REFERENCES harness.execution_inputs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  entered_at timestamptz,
  FOREIGN KEY (created_by_user_id,organization_id) REFERENCES harness.users(id,organization_id),
  FOREIGN KEY (organization_id,runtime_kind,runtime_public_id,session_id)
    REFERENCES harness.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id)
);
CREATE UNIQUE INDEX execution_inputs_first
  ON harness.execution_inputs(organization_id,runtime_kind,runtime_public_id,session_id,message_id,kind)
  WHERE previous_input_id IS NULL;
CREATE UNIQUE INDEX execution_inputs_edit
  ON harness.execution_inputs(previous_input_id,created_by_user_id,content_hash)
  WHERE previous_input_id IS NOT NULL;

CREATE FUNCTION harness.preserve_execution_input()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.entered_at IS NULL AND NEW.entered_at IS NOT NULL
    AND (to_jsonb(OLD)-'entered_at')=(to_jsonb(NEW)-'entered_at') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'execution inputs are immutable';
END;
$$;
CREATE TRIGGER execution_inputs_immutable BEFORE UPDATE OR DELETE ON harness.execution_inputs
  FOR EACH ROW EXECUTE FUNCTION harness.preserve_execution_input();

-- Relay retries refer to one receiver message, without retaining message bodies.
CREATE TABLE harness.execution_relays (
  organization_id uuid NOT NULL,
  runtime_kind text NOT NULL,
  runtime_public_id bigint NOT NULL,
  session_id text NOT NULL,
  message_id text NOT NULL CHECK (message_id <> ''),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (organization_id,runtime_kind,runtime_public_id,session_id,message_id),
  FOREIGN KEY (organization_id,runtime_kind,runtime_public_id,session_id)
    REFERENCES harness.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id)
);
