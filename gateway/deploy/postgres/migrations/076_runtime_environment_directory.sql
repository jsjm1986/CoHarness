-- Environment identities outlive process assignments. Owner and node UUIDs are
-- historical coordinates; current access always joins the live organization,
-- account, membership, project and node records.
CREATE TABLE harness.runtime_environments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  owner_kind text NOT NULL CHECK (owner_kind IN ('user','project')),
  owner_id uuid NOT NULL,
  node_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (id, organization_id)
);

CREATE UNIQUE INDEX runtime_environment_personal_node
  ON harness.runtime_environments(organization_id,owner_id,node_id)
  WHERE owner_kind='user' AND retired_at IS NULL;
CREATE UNIQUE INDEX runtime_environment_project
  ON harness.runtime_environments(organization_id,owner_id)
  WHERE owner_kind='project' AND retired_at IS NULL;
CREATE INDEX runtime_environment_account_page
  ON harness.runtime_environments(organization_id,owner_kind,owner_id,id)
  WHERE retired_at IS NULL;
CREATE INDEX runtime_environment_organization_page
  ON harness.runtime_environments(organization_id,id)
  WHERE retired_at IS NULL;

INSERT INTO harness.runtime_environments(id,organization_id,owner_kind,owner_id,node_id,created_at)
SELECT id,organization_id,CASE WHEN user_id IS NOT NULL THEN 'user' ELSE 'project' END,
  COALESCE(user_id,project_id),assigned_node_id,created_at
FROM harness.instances;

ALTER TABLE harness.instances ADD COLUMN runtime_id uuid;
UPDATE harness.instances SET runtime_id=id;
ALTER TABLE harness.instances
  ALTER COLUMN runtime_id SET NOT NULL,
  ADD CONSTRAINT instances_environment_unique UNIQUE(runtime_id),
  ADD CONSTRAINT instances_environment_organization_fkey
    FOREIGN KEY(runtime_id,organization_id)
    REFERENCES harness.runtime_environments(id,organization_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION harness.bind_runtime_environment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.runtime_id IS DISTINCT FROM OLD.runtime_id
      OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
      RAISE EXCEPTION 'runtime environment owner is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.assigned_node_id IS DISTINCT FROM OLD.assigned_node_id THEN
      IF OLD.observed_state<>'stopped' THEN
        RAISE EXCEPTION 'runtime environment reassignment requires a stopped instance' USING ERRCODE='23514';
      END IF;
      UPDATE harness.runtime_environments SET node_id=NEW.assigned_node_id
        WHERE id=NEW.runtime_id AND organization_id=NEW.organization_id AND retired_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'runtime environment is retired' USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.runtime_id IS NOT NULL THEN
    RAISE EXCEPTION 'runtime environment identity is assigned by the database' USING ERRCODE='23514';
  END IF;
  NEW.runtime_id=NEW.id;
  RETURN NEW;
END $$;

CREATE TRIGGER bind_runtime_environment BEFORE INSERT OR UPDATE ON harness.instances
  FOR EACH ROW EXECUTE FUNCTION harness.bind_runtime_environment();

-- AFTER INSERT runs only for actual inserts, so an instance
-- UPSERT preserves its original environment instead of reserving an orphan.
CREATE FUNCTION harness.register_runtime_environment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO harness.runtime_environments(id,organization_id,owner_kind,owner_id,node_id)
    VALUES(NEW.runtime_id,NEW.organization_id,
      CASE WHEN NEW.user_id IS NOT NULL THEN 'user' ELSE 'project' END,
      COALESCE(NEW.user_id,NEW.project_id),NEW.assigned_node_id);
  RETURN NEW;
END $$;

CREATE TRIGGER register_runtime_environment AFTER INSERT ON harness.instances
  FOR EACH ROW EXECUTE FUNCTION harness.register_runtime_environment();

CREATE FUNCTION harness.retire_runtime_environment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE harness.runtime_environments SET retired_at=now()
    WHERE id=OLD.runtime_id AND organization_id=OLD.organization_id;
  RETURN OLD;
END $$;

CREATE TRIGGER retire_runtime_environment AFTER DELETE ON harness.instances
  FOR EACH ROW EXECUTE FUNCTION harness.retire_runtime_environment();
