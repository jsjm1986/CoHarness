-- Access changes share one ordered outbox record per organization/transaction.
-- The organization row lock orders committed revisions; sequence allocation alone
-- could let a later commit advance readers past an uncommitted earlier record.
ALTER TABLE harness.organizations
  ADD COLUMN access_revision bigint NOT NULL DEFAULT 0 CHECK (access_revision >= 0);
ALTER TABLE harness.compute_nodes
  ADD COLUMN access_applied_revision bigint NOT NULL DEFAULT 0 CHECK (access_applied_revision >= 0);

CREATE UNIQUE INDEX outbox_access_transaction
  ON harness.outbox(organization_id, aggregate_id) WHERE topic='access.invalidate';
CREATE UNIQUE INDEX outbox_access_revision
  ON harness.outbox(organization_id, ((payload->>'revision')::bigint))
  WHERE topic='access.invalidate';

CREATE FUNCTION harness.invalidate_access(organization uuid, subject jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  event_id uuid;
  revision bigint;
  transaction_id text := pg_current_xact_id()::text;
BEGIN
  SELECT id INTO event_id FROM harness.outbox
    WHERE organization_id=organization AND topic='access.invalidate' AND aggregate_id=transaction_id;
  IF event_id IS NULL THEN
    UPDATE harness.organizations SET access_revision=access_revision+1
      WHERE id=organization RETURNING access_revision INTO revision;
    IF NOT FOUND THEN RETURN; END IF;
    INSERT INTO harness.outbox(organization_id,topic,aggregate_id,payload,completed_at)
      VALUES(organization,'access.invalidate',transaction_id,
        jsonb_build_object('revision',revision::text,'subjects',jsonb_build_array(subject)),now());
  ELSE
    UPDATE harness.outbox SET payload=jsonb_set(payload,'{subjects}',payload->'subjects' || jsonb_build_array(subject))
      WHERE id=event_id AND NOT (payload->'subjects' @> jsonb_build_array(subject));
  END IF;
  -- PostgreSQL coalesces identical channel/payload notifications in a transaction.
  PERFORM pg_notify('harness_access_invalidation',organization::text);
END;
$$;

CREATE FUNCTION harness.capture_access_invalidation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prior jsonb := to_jsonb(OLD);
  current_row jsonb := to_jsonb(NEW);
  organization uuid := (prior->>'organization_id')::uuid;
  user_id uuid;
  affected_project uuid;
  public_id bigint;
  subject jsonb;
BEGIN
  IF TG_OP='UPDATE' AND NOT EXISTS (
    SELECT 1 FROM unnest(string_to_array(TG_ARGV[0],',')) field
      WHERE prior->field IS DISTINCT FROM current_row->field
  ) THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='auth_sessions' THEN
    -- Sliding expiry/last-seen writes and cleanup of already dead tokens are not revocations.
    IF OLD.revoked_at IS NOT NULL OR OLD.expires_at<=now() OR OLD.absolute_expires_at<=now()
      OR (TG_OP='UPDATE' AND NEW.revoked_at IS NULL
        AND NEW.expires_at>=OLD.expires_at AND NEW.absolute_expires_at>=OLD.absolute_expires_at)
      THEN RETURN COALESCE(NEW,OLD); END IF;
  ELSIF TG_TABLE_NAME='conversation_sessions' AND TG_OP='UPDATE' THEN
    -- Closing a durable conversation preserves read access; deleting it does not.
    IF NOT EXISTS (SELECT 1 FROM unnest(ARRAY['visibility','project_id','creator_user_id','root_session_id']) field
      WHERE prior->field IS DISTINCT FROM current_row->field)
      AND (OLD.status='deleted') = (NEW.status='deleted') THEN RETURN NEW; END IF;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'organizations' THEN
      PERFORM harness.invalidate_access(OLD.id,'{}'::jsonb);
      RETURN COALESCE(NEW,OLD);
    WHEN 'users' THEN
      subject := jsonb_build_object('userId',OLD.public_id,'restartRuntime',true);
    WHEN 'password_credentials' THEN user_id := OLD.user_id;
    WHEN 'memberships' THEN user_id := OLD.user_id;
    WHEN 'auth_sessions' THEN user_id := OLD.user_id;
    WHEN 'project_members' THEN user_id := OLD.user_id;
    WHEN 'projects' THEN affected_project := OLD.id;
    WHEN 'project_mounts' THEN affected_project := OLD.project_id;
    WHEN 'conversation_sessions' THEN
      affected_project := OLD.project_id;
      IF affected_project IS NULL THEN user_id := OLD.creator_user_id; END IF;
    WHEN 'conversation_archive_records' THEN
      subject := jsonb_build_object(
        CASE WHEN OLD.runtime_kind='user' THEN 'userId' ELSE 'projectId' END,OLD.runtime_public_id);
    WHEN 'document_catalog' THEN
      affected_project := OLD.scope_project_id;
      user_id := OLD.scope_user_id;
    ELSE RAISE EXCEPTION 'unsupported access invalidation table: %',TG_TABLE_NAME;
  END CASE;
  IF user_id IS NOT NULL THEN
    SELECT u.public_id,u.organization_id INTO public_id,organization FROM harness.users u WHERE u.id=user_id;
    IF public_id IS NOT NULL THEN
      subject := jsonb_build_object('userId',public_id);
      IF TG_TABLE_NAME IN ('password_credentials','memberships','project_members') THEN
        subject := subject || '{"restartRuntime":true}'::jsonb;
      END IF;
    END IF;
  ELSIF affected_project IS NOT NULL THEN
    SELECT p.public_id INTO public_id FROM harness.projects p WHERE p.id=affected_project;
    IF public_id IS NOT NULL THEN
      subject := jsonb_build_object('projectId',public_id);
      IF TG_TABLE_NAME IN ('projects','project_mounts') THEN
        subject := subject || '{"restartRuntime":true}'::jsonb;
        -- Personal runtimes may hold directory grants for this project too.
        FOR public_id IN SELECT u.public_id FROM harness.project_members m
          JOIN harness.users u ON u.id=m.user_id WHERE m.project_id=affected_project
        LOOP
          PERFORM harness.invalidate_access(organization,jsonb_build_object('userId',public_id,'restartRuntime',true));
        END LOOP;
      END IF;
    END IF;
  END IF;
  IF subject IS NOT NULL THEN PERFORM harness.invalidate_access(organization,subject); END IF;
  RETURN COALESCE(NEW,OLD);
END;
$$;

-- INSERT grants no previously admitted access to revoke. In particular, catalog
-- registration during upload and Session creation must not cancel their own response.
CREATE TRIGGER organizations_access AFTER UPDATE OF status ON harness.organizations
  FOR EACH ROW EXECUTE FUNCTION harness.capture_access_invalidation('status');
CREATE TRIGGER users_access BEFORE UPDATE OF status,deleted_at,home_path OR DELETE ON harness.users
  FOR EACH ROW EXECUTE FUNCTION harness.capture_access_invalidation('status,deleted_at,home_path');
CREATE TRIGGER credentials_access BEFORE UPDATE OF password_hash,password_version,must_change_password OR DELETE ON harness.password_credentials
  FOR EACH ROW EXECUTE FUNCTION harness.capture_access_invalidation('password_hash,password_version,must_change_password');
CREATE TRIGGER memberships_access BEFORE UPDATE OF role,status OR DELETE ON harness.memberships
  FOR EACH ROW EXECUTE FUNCTION harness.capture_access_invalidation('role,status');
CREATE TRIGGER auth_sessions_access BEFORE UPDATE OF revoked_at,expires_at,absolute_expires_at OR DELETE ON harness.auth_sessions
  FOR EACH ROW EXECUTE FUNCTION harness.capture_access_invalidation('revoked_at,expires_at,absolute_expires_at');
CREATE TRIGGER project_members_access BEFORE UPDATE OF access_mode OR DELETE ON harness.project_members
  FOR EACH ROW EXECUTE FUNCTION harness.capture_access_invalidation('access_mode');
CREATE TRIGGER projects_access BEFORE UPDATE OF status,owner_user_id OR DELETE ON harness.projects
  FOR EACH ROW EXECUTE FUNCTION harness.capture_access_invalidation('status,owner_user_id');
CREATE TRIGGER project_mounts_access BEFORE UPDATE OF status,local_path,canonical_path OR DELETE ON harness.project_mounts
  FOR EACH ROW EXECUTE FUNCTION harness.capture_access_invalidation('status,local_path,canonical_path');
CREATE TRIGGER conversations_access BEFORE UPDATE OF visibility,project_id,creator_user_id,root_session_id,status OR DELETE ON harness.conversation_sessions
  FOR EACH ROW EXECUTE FUNCTION harness.capture_access_invalidation('visibility,project_id,creator_user_id,root_session_id,status');
CREATE TRIGGER archives_access BEFORE UPDATE OF state,runtime_kind,runtime_public_id,project_id,creator_user_id OR DELETE ON harness.conversation_archive_records
  FOR EACH ROW EXECUTE FUNCTION harness.capture_access_invalidation('state,runtime_kind,runtime_public_id,project_id,creator_user_id');
CREATE TRIGGER documents_access BEFORE UPDATE OF scope_kind,scope_user_id,scope_project_id,owner_user_id,directory_id,state OR DELETE ON harness.document_catalog
  FOR EACH ROW EXECUTE FUNCTION harness.capture_access_invalidation('scope_kind,scope_user_id,scope_project_id,owner_user_id,directory_id,state');
