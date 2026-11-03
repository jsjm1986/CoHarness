CREATE TABLE harness.computer_use_permissions (
  organization_id uuid NOT NULL,
  node_id uuid NOT NULL,
  user_id uuid NOT NULL,
  enabled boolean NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,node_id,user_id),
  FOREIGN KEY (node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id,organization_id) REFERENCES harness.users(id,organization_id) ON DELETE CASCADE
);
CREATE INDEX computer_use_account ON harness.computer_use_permissions(organization_id,user_id,node_id);

-- Preserve each account's existing personal-space host without granting other hosts.
INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled)
  SELECT organization_id,assigned_node_id,user_id,true FROM harness.instances WHERE user_id IS NOT NULL;

CREATE FUNCTION harness.computer_use_allowed(organization uuid,actor uuid,node uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM harness.computer_use_permissions permission
    JOIN harness.users u ON u.id=permission.user_id AND u.organization_id=permission.organization_id
    JOIN harness.memberships m ON m.user_id=u.id AND m.organization_id=u.organization_id
    JOIN harness.organizations o ON o.id=u.organization_id
    WHERE permission.organization_id=organization AND permission.user_id=actor AND permission.node_id=node
      AND permission.enabled AND u.status='active' AND u.deleted_at IS NULL AND m.status='active' AND o.status='active');
$$;

CREATE FUNCTION harness.project_computer_use_allowed(organization uuid,actor uuid,project uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM harness.instances i WHERE i.organization_id=organization AND i.project_id=project
    AND harness.computer_use_allowed(organization,actor,i.assigned_node_id));
$$;

-- Account creation still provisions its first personal space. A retired or
-- reassigned environment cannot turn a later allocation into an implicit grant.
CREATE FUNCTION harness.grant_initial_computer_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM harness.runtime_environments r
    WHERE r.organization_id=NEW.organization_id AND r.owner_kind='user' AND r.owner_id=NEW.user_id
      AND r.id<>NEW.runtime_id) THEN
    INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled)
      VALUES(NEW.organization_id,NEW.assigned_node_id,NEW.user_id,true) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zz_initial_computer_use AFTER INSERT ON harness.instances
  FOR EACH ROW EXECUTE FUNCTION harness.grant_initial_computer_use();

CREATE FUNCTION harness.invalidate_computer_use() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  public_id bigint;
BEGIN
  IF OLD.enabled AND (TG_OP='DELETE' OR NOT NEW.enabled) THEN
    SELECT u.public_id INTO public_id FROM harness.users u WHERE u.id=OLD.user_id AND u.organization_id=OLD.organization_id;
    IF public_id IS NOT NULL THEN
      PERFORM harness.invalidate_access(OLD.organization_id,jsonb_build_object(
        'userId',public_id,'nodeId',OLD.node_id,'restartRuntime',true));
    END IF;
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER computer_use_changes AFTER UPDATE OF enabled OR DELETE ON harness.computer_use_permissions
  FOR EACH ROW EXECUTE FUNCTION harness.invalidate_computer_use();
