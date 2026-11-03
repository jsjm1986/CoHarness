ALTER TABLE harness.runtime_environments ADD COLUMN storage_layout text NOT NULL DEFAULT 'legacy'
  CHECK(storage_layout IN ('legacy','isolated'));
UPDATE harness.runtime_environments environment SET storage_layout=instance.storage_layout
  FROM harness.instances instance WHERE instance.runtime_id=environment.id AND instance.organization_id=environment.organization_id;

CREATE OR REPLACE FUNCTION harness.register_runtime_environment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO harness.runtime_environments(id,organization_id,owner_kind,owner_id,node_id,storage_layout)
    VALUES(NEW.runtime_id,NEW.organization_id,
      CASE WHEN NEW.user_id IS NOT NULL THEN 'user' ELSE 'project' END,
      COALESCE(NEW.user_id,NEW.project_id),NEW.assigned_node_id,NEW.storage_layout);
  RETURN NEW;
END $$;

CREATE FUNCTION harness.guard_runtime_storage_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_layout IS DISTINCT FROM OLD.storage_layout THEN
    RAISE EXCEPTION 'Runtime storage history is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_runtime_storage_history BEFORE UPDATE ON harness.runtime_environments
  FOR EACH ROW EXECUTE FUNCTION harness.guard_runtime_storage_history();
