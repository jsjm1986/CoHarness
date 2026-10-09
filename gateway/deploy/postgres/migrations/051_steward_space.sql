-- The steward space is a reserved project row whose runtime stays resident and
-- whose admission comes from a dedicated user-scoped qualification lane, not
-- project membership. `kind` separates it from ordinary projects so catalog,
-- collaboration, and lifecycle queries can apply steward-specific rules.
ALTER TABLE harness.projects
  ADD COLUMN kind text NOT NULL DEFAULT 'standard',
  ADD CONSTRAINT projects_kind_check CHECK (kind IN ('standard','steward'));

-- One steward space per organization.
CREATE UNIQUE INDEX projects_steward_singleton ON harness.projects(organization_id) WHERE kind='steward';

-- Steward qualification follows the shared access-policy shape but admits only
-- user owners: the reserved project's membership list stays empty, so a
-- project-scoped row can never describe who may enter.
CREATE TABLE harness.steward_access_policies (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  user_id uuid,
  project_id uuid,
  enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL CHECK (revision > 0),
  CHECK (user_id IS NOT NULL AND project_id IS NULL),
  FOREIGN KEY (organization_id,user_id) REFERENCES harness.users(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,project_id) REFERENCES harness.projects(organization_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX steward_user_policy ON harness.steward_access_policies(organization_id,user_id) WHERE user_id IS NOT NULL;

CREATE FUNCTION harness.capture_steward_access_invalidation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  policy record := COALESCE(NEW,OLD);
  public_id bigint;
BEGIN
  IF TG_OP='UPDATE' AND OLD.enabled=NEW.enabled THEN RETURN NEW; END IF;
  SELECT u.public_id INTO public_id FROM harness.users u
    WHERE u.id=policy.user_id AND u.organization_id=policy.organization_id;
  IF public_id IS NOT NULL THEN
    PERFORM harness.invalidate_access(policy.organization_id,jsonb_build_object('userId',public_id));
  END IF;
  RETURN COALESCE(NEW,OLD);
END;
$$;
CREATE TRIGGER steward_access_changes AFTER INSERT OR UPDATE OR DELETE ON harness.steward_access_policies
  FOR EACH ROW EXECUTE FUNCTION harness.capture_steward_access_invalidation();

-- Every statement the steward runtime submits is journaled here: attempted,
-- denied, and executed statements alike, plus the approval interaction that
-- authorized a write.
CREATE TABLE harness.steward_query_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  runtime_generation bigint NOT NULL,
  statement text NOT NULL,
  classification text NOT NULL CHECK (classification IN ('read','write')),
  dry_run boolean NOT NULL,
  approval_interaction_id text,
  responder_user_id uuid,
  status text NOT NULL CHECK (status IN ('ok','denied','error')),
  row_count integer,
  result_bytes integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX steward_query_log_org_time ON harness.steward_query_log(organization_id, created_at DESC);
