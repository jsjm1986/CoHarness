-- Dedicated node database. No organization logins, credentials, policy or
-- organization database migrations belong in this database.
DO $$ BEGIN
  IF to_regnamespace('harness') IS NOT NULL THEN RAISE EXCEPTION 'organization database cannot host the node content schema'; END IF;
END $$;
CREATE SCHEMA node_content;
REVOKE ALL ON SCHEMA node_content FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE node_content.volume (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  organization_id uuid NOT NULL, node_id uuid NOT NULL, volume_id uuid NOT NULL UNIQUE,
  cluster_id text NOT NULL, database_oid oid NOT NULL
);
-- The caller can ask only for a fixed-length challenge under this cluster's
-- proof directory. Installation is an explicit DBA operation.
CREATE FUNCTION node_content.volume_proof(challenge uuid)
RETURNS TABLE(cluster_id text,database_oid oid,proof bytea,relation_path text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT (pg_control_system()).system_identifier::text,d.oid,
    sha256(pg_read_binary_file('harness-node-content-proofs/' || challenge::text,0,32,true)),
    pg_relation_filepath('node_content.volume'::regclass)
  FROM pg_database d WHERE d.datname=current_database() AND NOT pg_is_in_recovery()
$$;
REVOKE ALL ON FUNCTION node_content.volume_proof(uuid) FROM PUBLIC;
CREATE TABLE node_content.spaces (
  organization_id uuid NOT NULL, project_id uuid NOT NULL, node_id uuid NOT NULL,
  runtime_id uuid NOT NULL UNIQUE, volume_id uuid NOT NULL REFERENCES node_content.volume(volume_id),
  writer_epoch bigint NOT NULL CHECK(writer_epoch>0), revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  runtime_generation bigint NOT NULL DEFAULT 0 CHECK(runtime_generation>=0),
  name text NOT NULL, root_path text NOT NULL,
  PRIMARY KEY(organization_id,project_id), UNIQUE(organization_id,runtime_id,project_id)
);
CREATE TABLE node_content.conversation_sessions (
  organization_id uuid NOT NULL, runtime_id uuid NOT NULL, runtime_namespace text GENERATED ALWAYS AS (runtime_id::text) STORED,
  id text NOT NULL, creator_user_id uuid NOT NULL, project_id uuid NOT NULL,
  parent_session_id text, root_session_id text NOT NULL, visibility text NOT NULL CHECK(visibility IN ('project','private')),
  session_format_version integer NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  closed_at timestamptz, cwd text, seed_length bigint, origin text, delegation_depth integer,
  agent_preset text, draft boolean NOT NULL DEFAULT false, title text, ssh_target_id bigint,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed','deleted')),
  next_seq bigint NOT NULL DEFAULT 0 CHECK(next_seq>=0), event_count bigint NOT NULL DEFAULT 0 CHECK(event_count>=0),
  total_payload_bytes bigint NOT NULL DEFAULT 0 CHECK(total_payload_bytes>=0), version bigint NOT NULL DEFAULT 1,
  has_visible_content boolean NOT NULL DEFAULT false, visible_content_seq bigint, last_prompt_at timestamptz,
  PRIMARY KEY(organization_id,runtime_namespace,id), UNIQUE(organization_id,runtime_id,id),
  FOREIGN KEY(organization_id,runtime_id,project_id) REFERENCES node_content.spaces(organization_id,runtime_id,project_id),
  FOREIGN KEY(organization_id,runtime_id,parent_session_id) REFERENCES node_content.conversation_sessions(organization_id,runtime_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(organization_id,runtime_id,root_session_id) REFERENCES node_content.conversation_sessions(organization_id,runtime_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX node_conversation_root ON node_content.conversation_sessions(organization_id,runtime_id,root_session_id);
CREATE TABLE node_content.conversation_events (
  organization_id uuid NOT NULL,runtime_id uuid NOT NULL,runtime_namespace text GENERATED ALWAYS AS(runtime_id::text) STORED,
  session_id text NOT NULL,seq bigint NOT NULL CHECK(seq>=0),event_type text NOT NULL,occurred_at timestamptz NOT NULL,
  event json NOT NULL,payload_bytes integer NOT NULL CHECK(payload_bytes>=0),query_fields jsonb NOT NULL CHECK(jsonb_typeof(query_fields)='object'),
  PRIMARY KEY(organization_id,runtime_namespace,session_id,seq),
  FOREIGN KEY(organization_id,runtime_id,session_id) REFERENCES node_content.conversation_sessions(organization_id,runtime_id,id) ON DELETE CASCADE
);
CREATE INDEX node_conversation_event_types ON node_content.conversation_events(organization_id,runtime_namespace,session_id,event_type,seq);
CREATE TABLE node_content.conversation_append_batches (
  organization_id uuid NOT NULL,runtime_id uuid NOT NULL,runtime_namespace text GENERATED ALWAYS AS(runtime_id::text) STORED,
  batch_id uuid NOT NULL,session_id text NOT NULL,first_seq bigint NOT NULL,event_count integer NOT NULL,checksum bytea NOT NULL,
  PRIMARY KEY(organization_id,runtime_namespace,batch_id),
  FOREIGN KEY(organization_id,runtime_id,session_id) REFERENCES node_content.conversation_sessions(organization_id,runtime_id,id) ON DELETE CASCADE
);
CREATE TABLE node_content.conversation_search (
  organization_id uuid NOT NULL,runtime_id uuid NOT NULL,runtime_namespace text GENERATED ALWAYS AS(runtime_id::text) STORED,
  session_id text NOT NULL,event_seq bigint NOT NULL,role text NOT NULL CHECK(role IN ('user','assistant','tool')),
  content text NOT NULL,content_nul_parts text[],occurred_at timestamptz NOT NULL,
  PRIMARY KEY(organization_id,runtime_namespace,session_id,event_seq),
  FOREIGN KEY(organization_id,runtime_id,session_id) REFERENCES node_content.conversation_sessions(organization_id,runtime_id,id) ON DELETE CASCADE
);
CREATE INDEX node_conversation_search_trgm ON node_content.conversation_search USING gin(content gin_trgm_ops);
CREATE TABLE node_content.conversation_participants (
  organization_id uuid NOT NULL,runtime_id uuid NOT NULL,runtime_namespace text GENERATED ALWAYS AS(runtime_id::text) STORED,
  conversation_id text NOT NULL,user_id uuid NOT NULL,first_contributed_at timestamptz NOT NULL,last_contributed_at timestamptz NOT NULL,
  contribution_count bigint NOT NULL CHECK(contribution_count>0),PRIMARY KEY(organization_id,runtime_namespace,conversation_id,user_id),
  FOREIGN KEY(organization_id,runtime_id,conversation_id) REFERENCES node_content.conversation_sessions(organization_id,runtime_id,id) ON DELETE CASCADE
);
CREATE TABLE node_content.conversation_interaction_responses (
  organization_id uuid NOT NULL,runtime_id uuid NOT NULL,runtime_namespace text GENERATED ALWAYS AS(runtime_id::text) STORED,
  interaction_kind text NOT NULL CHECK(interaction_kind IN ('approval','question')),interaction_id text NOT NULL,conversation_id text NOT NULL,
  responder_user_id uuid NOT NULL,outcome json NOT NULL,has_answers boolean NOT NULL DEFAULT false,call_id text,responded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,runtime_namespace,interaction_kind,interaction_id),
  FOREIGN KEY(organization_id,runtime_id,conversation_id) REFERENCES node_content.conversation_sessions(organization_id,runtime_id,id) ON DELETE CASCADE
);
CREATE TABLE node_content.conversation_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,runtime_id uuid NOT NULL,
  runtime_namespace text GENERATED ALWAYS AS(runtime_id::text) STORED,session_id text NOT NULL,migration_id text NOT NULL,
  from_format_version integer NOT NULL,to_format_version integer NOT NULL,source_revision text NOT NULL,event_count bigint NOT NULL,
  UNIQUE(organization_id,runtime_namespace,session_id,migration_id),created_at timestamptz DEFAULT now() NOT NULL,
  FOREIGN KEY(organization_id,runtime_id,session_id) REFERENCES node_content.conversation_sessions(organization_id,runtime_id,id) ON DELETE CASCADE
);
CREATE TABLE node_content.conversation_migrated_events (
  migration_id uuid NOT NULL REFERENCES node_content.conversation_migrations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,runtime_id uuid NOT NULL,session_id text NOT NULL,seq bigint NOT NULL,event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,event json NOT NULL,payload_bytes bigint NOT NULL,PRIMARY KEY(migration_id,seq)
);
CREATE TABLE node_content.conversation_draft_reservations (
  organization_id uuid NOT NULL,runtime_id uuid NOT NULL,runtime_namespace text GENERATED ALWAYS AS(runtime_id::text) STORED,
  scope_key text NOT NULL,draft_id text NOT NULL,session_id text NOT NULL,user_id uuid NOT NULL,project_id uuid NOT NULL,
  cwd text NOT NULL,visibility text NOT NULL CHECK(visibility IN ('project','private')),agent_preset text,ssh_target_id bigint,
  lease_expires_at timestamptz NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,runtime_namespace,scope_key,draft_id),UNIQUE(organization_id,runtime_id,session_id),
  FOREIGN KEY(organization_id,runtime_id,project_id) REFERENCES node_content.spaces(organization_id,runtime_id,project_id)
);
CREATE TABLE node_content.conversation_archive_records (
  organization_id uuid NOT NULL,runtime_id uuid NOT NULL,root_session_id text NOT NULL,
  state text NOT NULL CHECK(state IN ('archived','trash','purged')),restored_at timestamptz,
  PRIMARY KEY(organization_id,runtime_id,root_session_id)
);
CREATE TABLE node_content.content_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,runtime_id uuid NOT NULL,
  runtime_namespace text GENERATED ALWAYS AS(runtime_id::text) STORED,session_id text NOT NULL,local_path text NOT NULL,
  FOREIGN KEY(organization_id,runtime_id,session_id) REFERENCES node_content.conversation_sessions(organization_id,runtime_id,id) ON DELETE CASCADE
);

-- Native json carries escaped NUL without converting it to PostgreSQL text or jsonb.
CREATE FUNCTION node_content.conversation_search_text(content text, nul_parts text[], maximum integer DEFAULT NULL)
RETURNS json LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE result json;
BEGIN
  IF maximum<0 THEN RAISE EXCEPTION 'search excerpt length must be nonnegative' USING ERRCODE='22023'; END IF;
  IF nul_parts IS NULL THEN
    RETURN to_json(CASE WHEN maximum IS NULL THEN content ELSE left(content,maximum) END);
  END IF;
  WITH pieces AS (
    SELECT piece,ordinality,COALESCE(sum(char_length(piece)+1) OVER (
      ORDER BY ordinality ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) start_at
    FROM unnest(CASE WHEN maximum IS NULL OR maximum>=cardinality(nul_parts)
      THEN nul_parts ELSE nul_parts[1:maximum+1] END) WITH ORDINALITY item(piece,ordinality)
  ), encoded AS (
    SELECT ordinality,to_json(CASE WHEN maximum IS NULL THEN piece
      ELSE left(piece,GREATEST(maximum-start_at,0)::integer) END)::text value
    FROM pieces WHERE maximum IS NULL OR start_at<=maximum
  )
  SELECT ('"'||string_agg(substring(value FROM 2 FOR char_length(value)-2),E'\\u0000' ORDER BY ordinality)||'"')::json
    INTO result FROM encoded;
  RETURN result;
END $$;

-- Each query piece must match consecutive stored pieces; empty pieces preserve adjacent NULs.
CREATE FUNCTION node_content.conversation_search_literal(content text, nul_parts text[], patterns text[])
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS(
    SELECT 1 FROM generate_subscripts(COALESCE(nul_parts,ARRAY[content]),1) start_at
    WHERE start_at+cardinality(patterns)-1<=cardinality(COALESCE(nul_parts,ARRAY[content]))
      AND NOT EXISTS(
        SELECT 1 FROM generate_subscripts(patterns,1) part
        WHERE NOT ((COALESCE(nul_parts,ARRAY[content]))[start_at+part-1] ILIKE patterns[part])
      )
  )
$$;
