-- The organization directory stores placement and identity only. Absence is the
-- existing shared-store layout. A published binding survives node disconnection.
ALTER TABLE harness.projects ADD COLUMN content_creation_xid xid8;
CREATE FUNCTION harness.retain_project_creation_xid() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN NEW.content_creation_xid=pg_current_xact_id();
  ELSE NEW.content_creation_xid=OLD.content_creation_xid; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retain_project_creation_xid BEFORE INSERT OR UPDATE OF content_creation_xid ON harness.projects
  FOR EACH ROW EXECUTE FUNCTION harness.retain_project_creation_xid();
CREATE TABLE harness.node_content_volumes (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  node_id uuid NOT NULL,
  volume_id uuid NOT NULL UNIQUE,
  cluster_id text NOT NULL CHECK(cluster_id ~ '^[0-9]+$'),
  database_oid oid NOT NULL,
  PRIMARY KEY(organization_id,node_id,volume_id),
  UNIQUE(cluster_id,database_oid),
  FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id)
);
CREATE TABLE harness.project_content_placement (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  node_id uuid NOT NULL,
  runtime_id uuid NOT NULL UNIQUE,
  volume_id uuid NOT NULL,
  writer_epoch bigint NOT NULL CHECK(writer_epoch>0),
  source_retirement text NOT NULL DEFAULT 'new' CHECK(source_retirement IN ('new','retiring','retired')),
  PRIMARY KEY(organization_id,project_id),
  FOREIGN KEY(project_id,organization_id) REFERENCES harness.projects(id,organization_id),
  FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
  FOREIGN KEY(organization_id,node_id,volume_id)
    REFERENCES harness.node_content_volumes(organization_id,node_id,volume_id)
);
-- Counts only projects with an explicitly prepared online copy. Queries and
-- unmigrated writes never open the destination database.
CREATE TABLE harness.project_content_copy_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,project_id uuid NOT NULL,
  runtime_id uuid NOT NULL,node_id uuid NOT NULL,volume_id uuid NOT NULL,
  registered_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),source_revision bigint NOT NULL DEFAULT 0,
  published boolean NOT NULL DEFAULT false,UNIQUE(organization_id,project_id),UNIQUE(organization_id,runtime_id),
  FOREIGN KEY(project_id,organization_id) REFERENCES harness.projects(id,organization_id),
  FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
  FOREIGN KEY(organization_id,node_id,volume_id) REFERENCES harness.node_content_volumes(organization_id,node_id,volume_id)
);
CREATE TABLE harness.node_journal_deliveries (
  organization_id uuid NOT NULL,project_id uuid NOT NULL,node_id uuid NOT NULL,runtime_id uuid NOT NULL,
  request_id uuid PRIMARY KEY,operation_id uuid NOT NULL,completed boolean NOT NULL DEFAULT false,
  queued_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,project_id) REFERENCES harness.project_content_placement(organization_id,project_id)
);
CREATE INDEX node_journal_deliveries_pending ON harness.node_journal_deliveries(organization_id,node_id,queued_at,request_id);
CREATE FUNCTION harness.project_content_key(org uuid,project uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('organizationId',organization_id,'projectId',project_id,'nodeId',node_id,
    'runtimeId',runtime_id,'volumeId',volume_id,'writerEpoch',writer_epoch::text)
  FROM harness.project_content_placement WHERE organization_id=org AND project_id=project;
$$;
CREATE FUNCTION harness.check_project_content_placement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'a published content placement cannot revert to shared storage' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM harness.runtime_environments r WHERE r.id=NEW.runtime_id
    AND r.organization_id=NEW.organization_id AND r.owner_kind='project' AND r.owner_id=NEW.project_id
    AND r.node_id=NEW.node_id AND r.retired_at IS NULL) THEN
    RAISE EXCEPTION 'content placement disagrees with the Runtime owner or computer' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (OLD.organization_id,OLD.project_id,OLD.runtime_id,OLD.node_id,OLD.volume_id,OLD.writer_epoch)
     IS DISTINCT FROM (NEW.organization_id,NEW.project_id,NEW.runtime_id,NEW.node_id,NEW.volume_id,NEW.writer_epoch) THEN
    RAISE EXCEPTION 'active content placement requires a fenced transition' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.source_retirement<>NEW.source_retirement
    AND NOT (OLD.source_retirement='retiring' AND NEW.source_retirement='retired') THEN
    RAISE EXCEPTION 'invalid source retirement transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER check_project_content_placement BEFORE INSERT OR UPDATE OR DELETE ON harness.project_content_placement
  FOR EACH ROW EXECUTE FUNCTION harness.check_project_content_placement();
CREATE FUNCTION harness.retain_published_content_owner() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT FROM harness.project_content_placement b WHERE
    (b.runtime_id=NEW.id OR (NEW.owner_kind='project' AND b.organization_id=NEW.organization_id AND b.project_id=NEW.owner_id))
    AND (b.runtime_id,b.organization_id,b.project_id,b.node_id,'project') IS DISTINCT FROM
      (NEW.id,NEW.organization_id,NEW.owner_id,NEW.node_id,NEW.owner_kind)) THEN
    RAISE EXCEPTION 'a published project requires its recorded Runtime and node' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retain_published_content_owner BEFORE INSERT OR UPDATE OF id,owner_kind,owner_id,organization_id,node_id ON harness.runtime_environments
  FOR EACH ROW EXECUTE FUNCTION harness.retain_published_content_owner();

-- Take the same owner/account locks as membership writers. PostgreSQL refreshes each
-- statement after a lock wait, while the Gateway makes a single authority request.
CREATE FUNCTION harness.node_project_content_writers(org uuid,project uuid,allocation uuid,node uuid,volume uuid,epoch bigint,
  internal_ids uuid[],public_ids bigint[]) RETURNS TABLE(id uuid,public_id bigint,administrator boolean)
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$
BEGIN
  PERFORM u.id FROM harness.users u WHERE u.organization_id=org AND (u.id=ANY(internal_ids) OR u.public_id=ANY(public_ids))
    ORDER BY u.id FOR SHARE OF u;
  PERFORM 1 FROM harness.project_content_placement b JOIN harness.projects p ON p.organization_id=b.organization_id AND p.id=b.project_id
    WHERE b.organization_id=org AND b.project_id=project AND b.runtime_id=allocation AND b.node_id=node AND b.volume_id=volume
      AND b.writer_epoch=epoch AND p.kind='standard' AND p.status='active' FOR SHARE OF b,p;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM m.user_id FROM harness.memberships m JOIN harness.users u ON m.organization_id=u.organization_id AND m.user_id=u.id
    WHERE m.organization_id=org AND (u.id=ANY(internal_ids) OR u.public_id=ANY(public_ids)) ORDER BY m.user_id FOR SHARE OF m;
  PERFORM pm.user_id FROM harness.project_members pm JOIN harness.users u ON pm.organization_id=u.organization_id AND pm.user_id=u.id
    WHERE pm.organization_id=org AND pm.project_id=project AND (u.id=ANY(internal_ids) OR u.public_id=ANY(public_ids))
    ORDER BY pm.user_id FOR SHARE OF pm;
  RETURN QUERY SELECT u.id,u.public_id,m.role='admin' FROM harness.users u
    JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id AND m.status='active'
    JOIN harness.organizations o ON o.id=u.organization_id AND o.status='active'
    LEFT JOIN harness.project_members pm ON pm.organization_id=u.organization_id AND pm.project_id=project AND pm.user_id=u.id
    WHERE u.organization_id=org AND (u.id=ANY(internal_ids) OR u.public_id=ANY(public_ids))
      AND u.status='active' AND u.deleted_at IS NULL AND (m.role='admin' OR pm.access_mode='rw')
      AND harness.project_computer_use_allowed(org,u.id,project);
END $$;

-- Older writers also fail closed after publication, even when the owning
-- content volume cannot be reached. The join covers a complete insert batch.
CREATE FUNCTION harness.refuse_remote_session_payload() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT FROM harness.project_content_copy_jobs j JOIN incoming r
      ON j.organization_id=r.organization_id AND j.runtime_id=r.runtime_id) THEN
    UPDATE harness.project_content_copy_jobs j SET source_revision=source_revision+1
      WHERE NOT published AND EXISTS(SELECT FROM incoming r WHERE r.organization_id=j.organization_id AND r.runtime_id=j.runtime_id);
    IF EXISTS(SELECT FROM harness.project_content_copy_jobs j JOIN incoming r
      ON j.organization_id=r.organization_id AND j.runtime_id=r.runtime_id WHERE j.published) THEN
      RAISE EXCEPTION 'Session content belongs to the assigned node volume' USING ERRCODE='23514';
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM incoming r JOIN harness.project_content_placement p
    ON p.organization_id=r.organization_id AND p.runtime_id=r.runtime_id) THEN
    RAISE EXCEPTION 'Session content belongs to the assigned node volume' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversation_sessions','conversation_events','conversation_search',
    'conversation_append_batches','conversation_draft_reservations','conversation_participants','conversation_interaction_responses',
    'conversation_migrations','conversation_migrated_events','execution_sessions','execution_inputs','execution_relays','execution_scopes','desktop_session_confirmations','plugin_states'] LOOP
    EXECUTE format('CREATE TRIGGER require_shared_insert AFTER INSERT ON harness.%I REFERENCING NEW TABLE AS incoming FOR EACH STATEMENT EXECUTE FUNCTION harness.refuse_remote_session_payload()', t);
    EXECUTE format('CREATE TRIGGER require_shared_update AFTER UPDATE ON harness.%I REFERENCING NEW TABLE AS incoming FOR EACH STATEMENT EXECUTE FUNCTION harness.refuse_remote_session_payload()', t);
    EXECUTE format('CREATE TRIGGER track_source_delete AFTER DELETE ON harness.%I REFERENCING OLD TABLE AS incoming FOR EACH STATEMENT EXECUTE FUNCTION harness.refuse_remote_session_payload()', t);
  END LOOP;
END $$;

-- Journal rows use project IDs and can change while the project's Runtime is asleep.
CREATE FUNCTION harness.require_shared_project_journal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  UPDATE harness.project_content_copy_jobs j SET source_revision=source_revision+1 WHERE NOT j.published AND EXISTS
    (SELECT FROM incoming r WHERE r.organization_id=j.organization_id AND r.project_id=j.project_id);
  IF EXISTS(SELECT FROM incoming r JOIN harness.project_content_placement b
    ON b.organization_id=r.organization_id AND b.project_id=r.project_id) THEN
    RAISE EXCEPTION 'project journal belongs to the assigned node volume' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['project_journal','project_journal_state','project_journal_materials','project_journal_requests'] LOOP
    EXECUTE format('CREATE TRIGGER require_shared_journal_insert AFTER INSERT ON harness.%I REFERENCING NEW TABLE AS incoming FOR EACH STATEMENT EXECUTE FUNCTION harness.require_shared_project_journal()',t);
    EXECUTE format('CREATE TRIGGER require_shared_journal_update AFTER UPDATE ON harness.%I REFERENCING NEW TABLE AS incoming FOR EACH STATEMENT EXECUTE FUNCTION harness.require_shared_project_journal()',t);
    EXECUTE format('CREATE TRIGGER track_journal_delete AFTER DELETE ON harness.%I REFERENCING OLD TABLE AS incoming FOR EACH STATEMENT EXECUTE FUNCTION harness.require_shared_project_journal()',t);
  END LOOP;
END $$;
