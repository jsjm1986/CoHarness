ALTER TABLE harness.plugin_states ADD COLUMN runtime_id uuid;
UPDATE harness.plugin_states state SET runtime_id=instance.runtime_id FROM harness.instances instance
  WHERE instance.organization_id=state.organization_id AND
    ((state.user_id IS NOT NULL AND instance.user_id=state.user_id) OR
     (state.project_id IS NOT NULL AND instance.project_id=state.project_id));
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM harness.plugin_states WHERE runtime_id IS NULL) THEN
    RAISE EXCEPTION 'plugin configuration requires its original Runtime assignment before upgrade' USING ERRCODE='23514';
  END IF;
END $$;
ALTER TABLE harness.plugin_states ALTER COLUMN runtime_id SET NOT NULL;
ALTER TABLE harness.plugin_states ADD CONSTRAINT plugin_runtime_environment FOREIGN KEY(runtime_id,organization_id)
  REFERENCES harness.runtime_environments(id,organization_id);
DROP INDEX harness.plugin_user_state;
DROP INDEX harness.plugin_project_state;
CREATE UNIQUE INDEX plugin_runtime_state ON harness.plugin_states(organization_id,runtime_id);

CREATE FUNCTION harness.validate_plugin_runtime_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM harness.runtime_environments runtime WHERE runtime.organization_id=NEW.organization_id
    AND runtime.id=NEW.runtime_id AND runtime.owner_kind=CASE WHEN NEW.user_id IS NULL THEN 'project' ELSE 'user' END
    AND runtime.owner_id=COALESCE(NEW.user_id,NEW.project_id)) THEN
    RAISE EXCEPTION 'plugin configuration belongs to another Runtime owner' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_plugin_runtime_owner BEFORE INSERT OR UPDATE ON harness.plugin_states
  FOR EACH ROW EXECUTE FUNCTION harness.validate_plugin_runtime_owner();
