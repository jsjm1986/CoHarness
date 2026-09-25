-- User terminal qualification is independent of model permission presets and resource leases.
CREATE TABLE harness.terminal_access_policies (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  user_id uuid,
  project_id uuid,
  enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL CHECK (revision > 0),
  CHECK ((user_id IS NOT NULL)::integer + (project_id IS NOT NULL)::integer = 1),
  FOREIGN KEY (organization_id,user_id) REFERENCES harness.users(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,project_id) REFERENCES harness.projects(organization_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX terminal_user_policy ON harness.terminal_access_policies(organization_id,user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX terminal_project_policy ON harness.terminal_access_policies(organization_id,project_id) WHERE project_id IS NOT NULL;

CREATE FUNCTION harness.capture_terminal_access_invalidation()
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
CREATE TRIGGER terminal_access_changes AFTER INSERT OR UPDATE OR DELETE ON harness.terminal_access_policies
  FOR EACH ROW EXECUTE FUNCTION harness.capture_terminal_access_invalidation();
