-- Runtime-local archive identity, transcript lookup and the command/retry ledger share one volume.
ALTER TABLE node_content.conversation_archive_records
  ADD COLUMN archive_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN node_id uuid,
  ADD COLUMN runtime_kind text NOT NULL DEFAULT 'project' CHECK(runtime_kind='project'),
  ADD COLUMN runtime_public_id bigint CHECK(runtime_public_id>0),
  ADD COLUMN project_id uuid,
  ADD COLUMN creator_user_id uuid,
  ADD COLUMN title text,
  ADD COLUMN workspace_path text,
  ADD COLUMN workspace_title text,
  ADD COLUMN workspace_position integer CHECK(workspace_position>=0),
  ADD COLUMN message_count bigint NOT NULL DEFAULT 0 CHECK(message_count>=0),
  ADD COLUMN archived_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN archived_by_user_id uuid,
  ADD COLUMN restored_by_user_id uuid,
  ADD COLUMN trashed_at timestamptz,
  ADD COLUMN trashed_by_user_id uuid,
  ADD COLUMN purge_after timestamptz,
  ADD COLUMN sync_revision bigint NOT NULL DEFAULT 0 CHECK(sync_revision>=0),
  ADD COLUMN sync_state text NOT NULL DEFAULT 'pending' CHECK(sync_state IN ('pending','synced','conflict','unavailable')),
  ADD COLUMN last_sync_error text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN record_kind text NOT NULL DEFAULT 'conversation' CHECK(record_kind IN ('conversation','empty-draft')),
  ADD UNIQUE(archive_id), ADD UNIQUE(organization_id,archive_id,runtime_id),
  ALTER COLUMN state SET DEFAULT 'archived';
UPDATE node_content.conversation_archive_records a SET node_id=s.node_id,project_id=s.project_id
  FROM node_content.spaces s WHERE (a.organization_id,a.runtime_id)=(s.organization_id,s.runtime_id);
ALTER TABLE node_content.conversation_archive_records
  ADD FOREIGN KEY(organization_id,runtime_id,project_id) REFERENCES node_content.spaces(organization_id,runtime_id,project_id);
CREATE INDEX archive_list ON node_content.conversation_archive_records(organization_id,node_id,archived_at DESC,archive_id);
CREATE INDEX archive_due ON node_content.conversation_archive_records(purge_after) WHERE state='trash' AND purge_after IS NOT NULL;
CREATE TABLE node_content.conversation_archive_search (
  organization_id uuid NOT NULL, archive_id uuid NOT NULL, runtime_id uuid NOT NULL, session_id text NOT NULL,
  event_seq bigint NOT NULL CHECK(event_seq>=0),role text NOT NULL CHECK(role IN ('user','assistant')),
  content text NOT NULL, content_nul_parts text[],occurred_at timestamptz NOT NULL,
  PRIMARY KEY(organization_id,runtime_id,session_id,event_seq),
  FOREIGN KEY(organization_id,archive_id,runtime_id) REFERENCES node_content.conversation_archive_records(organization_id,archive_id,runtime_id) ON DELETE CASCADE
);
CREATE INDEX archive_content_trgm ON node_content.conversation_archive_search USING gin(content gin_trgm_ops);
CREATE INDEX archive_search_time ON node_content.conversation_archive_search(organization_id,archive_id,occurred_at);
CREATE TABLE node_content.conversation_archive_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,archive_id uuid NOT NULL,runtime_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('restore','trash','purge')),requested_by_user_id uuid,requested_at timestamptz NOT NULL DEFAULT now(),
  desired_revision bigint NOT NULL CHECK(desired_revision>=0),status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','failed')),
  error text,applied_at timestamptz,idempotency_key text,UNIQUE(organization_id,idempotency_key),
  FOREIGN KEY(organization_id,archive_id,runtime_id) REFERENCES node_content.conversation_archive_records(organization_id,archive_id,runtime_id) ON DELETE CASCADE
);
CREATE INDEX archive_pending ON node_content.conversation_archive_commands(organization_id,runtime_id,requested_at,id) WHERE status='pending';
CREATE TABLE node_content.conversation_archive_file_cleanup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,node_id uuid NOT NULL,archive_id uuid NOT NULL,runtime_id uuid NOT NULL,
  local_path text NOT NULL CHECK(char_length(local_path) BETWEEN 1 AND 4096), attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,last_error text,created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,archive_id,local_path),
  FOREIGN KEY(organization_id,archive_id,runtime_id) REFERENCES node_content.conversation_archive_records(organization_id,archive_id,runtime_id) ON DELETE CASCADE
);
CREATE INDEX archive_cleanup_due ON node_content.conversation_archive_file_cleanup(organization_id,node_id,next_attempt_at,lease_until,created_at);
CREATE FUNCTION node_content.bind_archive_child() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE owner uuid;
BEGIN
  SELECT a.runtime_id INTO STRICT owner FROM node_content.conversation_archive_records a
    WHERE a.organization_id=NEW.organization_id AND a.archive_id=NEW.archive_id;
  IF NEW.runtime_id IS NOT NULL AND NEW.runtime_id<>owner THEN RAISE EXCEPTION 'wrong archive allocation' USING ERRCODE='23514'; END IF;
  NEW.runtime_id:=owner;
  RETURN NEW;
END $$;
CREATE TRIGGER bind_archive_command BEFORE INSERT OR UPDATE OF organization_id,archive_id,runtime_id ON node_content.conversation_archive_commands
  FOR EACH ROW EXECUTE FUNCTION node_content.bind_archive_child();
CREATE TRIGGER bind_archive_cleanup BEFORE INSERT OR UPDATE OF organization_id,archive_id,runtime_id ON node_content.conversation_archive_file_cleanup
  FOR EACH ROW EXECUTE FUNCTION node_content.bind_archive_child();
CREATE FUNCTION node_content.check_archive_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE space node_content.spaces%ROWTYPE;
BEGIN
  SELECT * INTO STRICT space FROM node_content.spaces WHERE organization_id=NEW.organization_id AND runtime_id=NEW.runtime_id;
  IF NEW.project_id IS NOT NULL AND NEW.project_id<>space.project_id OR NEW.node_id IS NOT NULL AND NEW.node_id<>space.node_id
    THEN RAISE EXCEPTION 'wrong archive space' USING ERRCODE='23514'; END IF;
  NEW.node_id:=space.node_id;
  NEW.project_id:=space.project_id;
  IF TG_OP='UPDATE' AND (NEW.organization_id,NEW.node_id,NEW.runtime_id,NEW.archive_id,NEW.root_session_id)
    IS DISTINCT FROM (OLD.organization_id,OLD.node_id,OLD.runtime_id,OLD.archive_id,OLD.root_session_id) THEN
    RAISE EXCEPTION 'archive identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_archive_identity BEFORE INSERT OR UPDATE ON node_content.conversation_archive_records
  FOR EACH ROW EXECUTE FUNCTION node_content.check_archive_identity();

-- Attachment rows may predate the explicit project reference.
ALTER TABLE node_content.content_files ADD COLUMN project_id uuid,
  ADD FOREIGN KEY(organization_id,runtime_id,project_id) REFERENCES node_content.spaces(organization_id,runtime_id,project_id);
CREATE INDEX content_file_path ON node_content.content_files(organization_id,local_path);

-- Retain any predecessor's full project workspace projection without disclosing it to other members.
ALTER TABLE node_content.workspace_catalog ADD COLUMN predecessor_conversations jsonb CHECK(jsonb_typeof(predecessor_conversations)='array');

ALTER TABLE node_content.conversation_archive_file_cleanup
  ADD COLUMN expected_sha256 char(64), ADD COLUMN expected_bytes bigint CHECK(expected_bytes>=0),
  ADD CHECK((expected_sha256 IS NULL)=(expected_bytes IS NULL));
