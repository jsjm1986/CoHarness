-- Execution witnesses belong to the Runtime that registered the Session.
ALTER TABLE harness.execution_sessions ADD COLUMN runtime_id uuid;
UPDATE harness.execution_sessions session SET runtime_id=instance.runtime_id
  FROM harness.instances instance
  LEFT JOIN harness.users account ON account.organization_id=instance.organization_id AND account.id=instance.user_id
  LEFT JOIN harness.projects project ON project.organization_id=instance.organization_id AND project.id=instance.project_id
  WHERE instance.organization_id=session.organization_id
    AND session.runtime_kind=CASE WHEN instance.user_id IS NULL THEN 'project' ELSE 'user' END
    AND session.runtime_public_id=COALESCE(account.public_id,project.public_id);
ALTER TABLE harness.execution_sessions
  ADD CONSTRAINT execution_runtime_environment FOREIGN KEY(runtime_id,organization_id)
    REFERENCES harness.runtime_environments(id,organization_id),
  ADD CONSTRAINT execution_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID;
CREATE INDEX execution_runtime_sessions ON harness.execution_sessions(organization_id,runtime_id,session_id);

CREATE FUNCTION harness.validate_execution_runtime_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.runtime_id IS DISTINCT FROM OLD.runtime_id THEN
    RAISE EXCEPTION 'execution Session Runtime is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.runtime_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM harness.runtime_environments runtime
    LEFT JOIN harness.users account ON runtime.owner_kind='user' AND account.organization_id=runtime.organization_id AND account.id=runtime.owner_id
    LEFT JOIN harness.projects project ON runtime.owner_kind='project' AND project.organization_id=runtime.organization_id AND project.id=runtime.owner_id
    WHERE runtime.id=NEW.runtime_id AND runtime.organization_id=NEW.organization_id AND runtime.owner_kind=NEW.runtime_kind
      AND COALESCE(account.public_id,project.public_id)=NEW.runtime_public_id) THEN
    RAISE EXCEPTION 'execution Session belongs to another Runtime owner' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_execution_runtime_owner BEFORE INSERT OR UPDATE ON harness.execution_sessions
  FOR EACH ROW EXECUTE FUNCTION harness.validate_execution_runtime_owner();
