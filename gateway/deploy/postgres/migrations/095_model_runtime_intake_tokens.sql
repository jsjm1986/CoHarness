-- Usage receipts retain account/project billing while each Runtime owns an independent reporting credential.
CREATE TABLE harness.model_runtime_intake_tokens (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  runtime_id uuid NOT NULL,
  node_id uuid NOT NULL,
  user_id uuid,
  project_id uuid,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,runtime_id),
  CHECK((user_id IS NULL)<>(project_id IS NULL)),
  FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
  FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
  FOREIGN KEY(user_id,organization_id) REFERENCES harness.users(id,organization_id),
  FOREIGN KEY(project_id,organization_id) REFERENCES harness.projects(id,organization_id)
);

CREATE FUNCTION harness.validate_model_runtime_token() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.runtime_id IS DISTINCT FROM OLD.runtime_id OR NEW.node_id IS DISTINCT FROM OLD.node_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
    RAISE EXCEPTION 'Model reporting credential owner is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM harness.runtime_environments environment
    WHERE environment.organization_id=NEW.organization_id AND environment.id=NEW.runtime_id AND environment.node_id=NEW.node_id
      AND environment.owner_kind=CASE WHEN NEW.user_id IS NULL THEN 'project' ELSE 'user' END
      AND environment.owner_id=COALESCE(NEW.user_id,NEW.project_id)) THEN
    RAISE EXCEPTION 'Model reporting credential belongs to another Runtime' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_model_runtime_token BEFORE INSERT OR UPDATE ON harness.model_runtime_intake_tokens
  FOR EACH ROW EXECUTE FUNCTION harness.validate_model_runtime_token();
