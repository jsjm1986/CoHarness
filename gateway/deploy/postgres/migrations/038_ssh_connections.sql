-- Administrator-registered OpenSSH targets; connection values are released only
-- to managed runtimes whose execution identity passes qualification and sharing.
CREATE TABLE harness.ssh_targets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  public_id bigint GENERATED ALWAYS AS IDENTITY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  host text NOT NULL CHECK (length(host) BETWEEN 1 AND 256),
  node text NOT NULL CHECK (length(node) BETWEEN 1 AND 1024),
  helper text NOT NULL CHECK (length(helper) BETWEEN 1 AND 1024),
  helper_hash text NOT NULL CHECK (helper_hash ~ '^[0-9a-f]{64}$'),
  workspace text NOT NULL CHECK (length(workspace) BETWEEN 1 AND 1024),
  bootstrap_path text CHECK (bootstrap_path IS NULL OR length(bootstrap_path) BETWEEN 1 AND 1024),
  bootstrap_hash text CHECK (bootstrap_hash IS NULL OR bootstrap_hash ~ '^[0-9a-f]{64}$'),
  request_timeout_ms integer CHECK (request_timeout_ms IS NULL OR request_timeout_ms BETWEEN 1 AND 2147483647),
  max_frame_bytes integer CHECK (max_frame_bytes IS NULL OR max_frame_bytes > 0),
  max_pending integer CHECK (max_pending IS NULL OR max_pending > 0),
  lease_ms integer CHECK (lease_ms IS NULL OR lease_ms > 0),
  enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, public_id),
  UNIQUE (organization_id, name),
  CHECK ((bootstrap_path IS NULL) = (bootstrap_hash IS NULL)),
  FOREIGN KEY (created_by, organization_id) REFERENCES harness.users(id, organization_id)
);

-- SSH qualification is independent of model permission presets and terminal grants.
CREATE TABLE harness.ssh_access_policies (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  user_id uuid,
  project_id uuid,
  enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL CHECK (revision > 0),
  CHECK ((user_id IS NOT NULL)::integer + (project_id IS NOT NULL)::integer = 1),
  FOREIGN KEY (organization_id,user_id) REFERENCES harness.users(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,project_id) REFERENCES harness.projects(organization_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ssh_user_policy ON harness.ssh_access_policies(organization_id,user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX ssh_project_policy ON harness.ssh_access_policies(organization_id,project_id) WHERE project_id IS NOT NULL;

CREATE FUNCTION harness.capture_ssh_access_invalidation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  policy record := COALESCE(NEW,OLD);
  public_id bigint;
  subject jsonb;
BEGIN
  IF TG_OP='UPDATE' AND OLD.enabled=NEW.enabled THEN RETURN NEW; END IF;
  IF policy.user_id IS NOT NULL THEN
    SELECT u.public_id INTO public_id FROM harness.users u WHERE u.id=policy.user_id AND u.organization_id=policy.organization_id;
    subject := jsonb_build_object('userId',public_id);
  ELSE
    SELECT p.public_id INTO public_id FROM harness.projects p WHERE p.id=policy.project_id AND p.organization_id=policy.organization_id;
    subject := jsonb_build_object('projectId',public_id);
  END IF;
  IF public_id IS NOT NULL THEN PERFORM harness.invalidate_access(policy.organization_id,subject); END IF;
  RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER ssh_access_changes AFTER INSERT OR UPDATE OR DELETE ON harness.ssh_access_policies
  FOR EACH ROW EXECUTE FUNCTION harness.capture_ssh_access_invalidation();

-- A project share admits the target inside that project's runtimes; every
-- executing user still needs personal SSH qualification. Share removal cuts the
-- project's runtimes through the same access outbox.
CREATE TABLE harness.ssh_target_shares (
  organization_id uuid NOT NULL,
  target_id uuid NOT NULL,
  project_id uuid NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, target_id, project_id),
  FOREIGN KEY (organization_id, target_id) REFERENCES harness.ssh_targets(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, project_id) REFERENCES harness.projects(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (created_by, organization_id) REFERENCES harness.users(id, organization_id)
);

CREATE FUNCTION harness.capture_ssh_target_invalidation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target record := COALESCE(NEW,OLD);
BEGIN
  PERFORM harness.invalidate_access(target.organization_id,'{}'::jsonb);
  RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER ssh_target_changes AFTER UPDATE OR DELETE ON harness.ssh_targets
  FOR EACH ROW EXECUTE FUNCTION harness.capture_ssh_target_invalidation();

CREATE FUNCTION harness.capture_ssh_share_invalidation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  share record := COALESCE(NEW,OLD);
  public_id bigint;
BEGIN
  SELECT p.public_id INTO public_id FROM harness.projects p WHERE p.id=share.project_id AND p.organization_id=share.organization_id;
  IF public_id IS NOT NULL THEN
    PERFORM harness.invalidate_access(share.organization_id,jsonb_build_object('projectId',public_id));
  END IF;
  RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER ssh_share_changes AFTER INSERT OR DELETE ON harness.ssh_target_shares
  FOR EACH ROW EXECUTE FUNCTION harness.capture_ssh_share_invalidation();
