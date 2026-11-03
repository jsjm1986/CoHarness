-- A process-owned operation survives transient stopped publications and assignment deletion.
ALTER TABLE harness.node_resource_gateways
  ADD CONSTRAINT node_resource_gateway_generation_unique UNIQUE(organization_id,node_id,owner_id,generation);

CREATE TABLE harness.runtime_destructive_operations (
  organization_id uuid NOT NULL,
  runtime_id uuid NOT NULL,
  node_id uuid NOT NULL,
  generation bigint NOT NULL CHECK(generation>0),
  operation_id uuid NOT NULL UNIQUE,
  gateway_owner_id uuid NOT NULL,
  gateway_generation bigint NOT NULL,
  PRIMARY KEY(organization_id,runtime_id),
  FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id) ON DELETE CASCADE,
  FOREIGN KEY(organization_id,node_id,gateway_owner_id,gateway_generation)
    REFERENCES harness.node_resource_gateways(organization_id,node_id,owner_id,generation) ON DELETE CASCADE
);

CREATE FUNCTION harness.guard_runtime_destructive_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF EXISTS(SELECT 1 FROM harness.runtime_destructive_operations operation
      JOIN harness.runtime_environments environment ON environment.id=operation.runtime_id
        AND environment.organization_id=operation.organization_id
      WHERE operation.organization_id=NEW.organization_id
        AND environment.owner_kind=CASE WHEN NEW.user_id IS NOT NULL THEN 'user' ELSE 'project' END
        AND environment.owner_id=COALESCE(NEW.user_id,NEW.project_id)) THEN
      RAISE EXCEPTION 'runtime destructive operation is pending'
        USING ERRCODE='55000',CONSTRAINT='runtime_destructive_operation';
    END IF;
  ELSIF (NEW.generation IS DISTINCT FROM OLD.generation
    OR NEW.assigned_node_id IS DISTINCT FROM OLD.assigned_node_id
    OR NEW.observed_state IN ('starting','ready'))
    AND EXISTS(SELECT 1 FROM harness.runtime_destructive_operations operation
      WHERE operation.organization_id=OLD.organization_id AND operation.runtime_id=OLD.runtime_id) THEN
    RAISE EXCEPTION 'runtime destructive operation is pending'
      USING ERRCODE='55000',CONSTRAINT='runtime_destructive_operation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER guard_runtime_destructive_operation BEFORE INSERT OR UPDATE ON harness.instances
  FOR EACH ROW EXECUTE FUNCTION harness.guard_runtime_destructive_operation();
