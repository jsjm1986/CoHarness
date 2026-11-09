-- The Runtime's immutable input receipts and question answers share one local commit.
ALTER TABLE node_content.spaces ADD UNIQUE(organization_id,runtime_id);
CREATE TABLE node_content.execution_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,runtime_kind text NOT NULL CHECK(runtime_kind='project'),
  runtime_public_id bigint NOT NULL CHECK(runtime_public_id>0),session_id text NOT NULL CHECK(session_id<>''),runtime_id uuid NOT NULL,
  parent_session_id text CHECK(parent_session_id<>session_id),is_seeded boolean NOT NULL DEFAULT false,
  actor_witnesses jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(actor_witnesses)='object'),primary_actor_user_id uuid,
  unverified_history boolean NOT NULL DEFAULT false,inheritance_hash text CHECK(inheritance_hash~'^[0-9a-f]{64}$'),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id),
  FOREIGN KEY(organization_id,runtime_id) REFERENCES node_content.spaces(organization_id,runtime_id),
  FOREIGN KEY(organization_id,runtime_kind,runtime_public_id,parent_session_id,runtime_id)
    REFERENCES node_content.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE node_content.execution_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,runtime_kind text NOT NULL,runtime_public_id bigint NOT NULL,
  session_id text NOT NULL,runtime_id uuid NOT NULL,message_id text NOT NULL CHECK(message_id<>''),
  kind text NOT NULL CHECK(kind IN ('message','question')),content_hash text NOT NULL CHECK(content_hash~'^[0-9a-f]{64}$'),
  created_by_user_id uuid NOT NULL,actor_user_ids uuid[] NOT NULL CHECK(cardinality(actor_user_ids)>0),
  previous_input_id uuid REFERENCES node_content.execution_inputs(id) DEFERRABLE INITIALLY DEFERRED,created_at timestamptz NOT NULL DEFAULT now(),entered_at timestamptz,
  FOREIGN KEY(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id)
    REFERENCES node_content.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id)
);
CREATE UNIQUE INDEX execution_inputs_first ON node_content.execution_inputs(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,message_id,kind)
 WHERE previous_input_id IS NULL;
CREATE UNIQUE INDEX execution_inputs_edit ON node_content.execution_inputs(previous_input_id,created_by_user_id,content_hash) WHERE previous_input_id IS NOT NULL;
CREATE TABLE node_content.execution_relays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,runtime_kind text NOT NULL,runtime_public_id bigint NOT NULL,
  session_id text NOT NULL,runtime_id uuid NOT NULL,message_id text NOT NULL CHECK(message_id<>''),request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'),
  UNIQUE(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,message_id),
  FOREIGN KEY(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id)
    REFERENCES node_content.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id)
);
CREATE TABLE node_content.execution_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,runtime_kind text NOT NULL,runtime_public_id bigint NOT NULL,
  session_id text NOT NULL,runtime_id uuid NOT NULL,fingerprint text NOT NULL,revision bigint NOT NULL,input_ids uuid[] NOT NULL,
  primary_actor_user_id uuid,unverified boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,fingerprint),
  CHECK(cardinality(input_ids)>0 OR (unverified AND primary_actor_user_id IS NULL)),
  FOREIGN KEY(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id)
    REFERENCES node_content.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id)
);
CREATE FUNCTION node_content.preserve_execution_witness() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='execution_inputs' AND TG_OP='UPDATE' THEN
    IF OLD.entered_at IS NULL AND NEW.entered_at IS NOT NULL AND (to_jsonb(OLD)-'entered_at')=(to_jsonb(NEW)-'entered_at') THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'execution witness is immutable';
END $$;
CREATE TRIGGER immutable_execution_input BEFORE UPDATE OR DELETE ON node_content.execution_inputs FOR EACH ROW EXECUTE FUNCTION node_content.preserve_execution_witness();
CREATE TRIGGER immutable_execution_scope BEFORE UPDATE OR DELETE ON node_content.execution_scopes FOR EACH ROW EXECUTE FUNCTION node_content.preserve_execution_witness();
CREATE TABLE node_content.desktop_session_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,runtime_kind text NOT NULL,runtime_public_id bigint NOT NULL,
  session_id text NOT NULL,runtime_id uuid NOT NULL,node_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>0),
  desktop text NOT NULL CHECK(octet_length(desktop) BETWEEN 1 AND 256),user_id uuid NOT NULL,
  user_policy_revision bigint NOT NULL CHECK(user_policy_revision>0),project_policy_revision bigint NOT NULL CHECK(project_policy_revision>=0),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,node_id,generation,desktop,user_id),
  FOREIGN KEY(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id)
    REFERENCES node_content.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id) ON DELETE CASCADE
);
