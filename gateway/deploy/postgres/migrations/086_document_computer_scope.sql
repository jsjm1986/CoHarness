-- Personal working documents are shared by the account's Runtimes on one computer.
ALTER TABLE harness.document_catalog ADD COLUMN node_id uuid;
ALTER TABLE harness.document_projection_checkpoints ADD COLUMN node_id uuid;
ALTER TABLE harness.document_operations ADD COLUMN node_id uuid;

UPDATE harness.document_catalog document SET node_id=instance.assigned_node_id FROM harness.instances instance
  WHERE instance.organization_id=document.organization_id AND
    ((document.scope_kind='personal' AND instance.user_id=document.scope_user_id) OR
     (document.scope_kind='project' AND instance.project_id=document.scope_project_id));
UPDATE harness.document_projection_checkpoints checkpoint SET node_id=instance.assigned_node_id FROM harness.instances instance
  WHERE instance.organization_id=checkpoint.organization_id AND
    ((checkpoint.scope_kind='personal' AND instance.user_id=checkpoint.scope_user_id) OR
     (checkpoint.scope_kind='project' AND instance.project_id=checkpoint.scope_project_id));
UPDATE harness.document_operations operation SET node_id=instance.assigned_node_id FROM harness.instances instance
  WHERE instance.organization_id=operation.organization_id AND
    ((operation.source_scope_kind='personal' AND instance.user_id=operation.source_user_id) OR
     (operation.source_scope_kind='project' AND instance.project_id=operation.source_project_id) OR
     (operation.source_scope_kind IS NULL AND operation.target_scope_kind='personal' AND instance.user_id=operation.target_user_id) OR
     (operation.source_scope_kind IS NULL AND operation.target_scope_kind='project' AND instance.project_id=operation.target_project_id));
UPDATE harness.document_operations operation SET node_id=document.node_id FROM harness.document_operation_items item
  JOIN harness.document_catalog document ON document.id=COALESCE(item.source_catalog_id,item.target_catalog_id)
  WHERE operation.organization_id=item.organization_id AND operation.id=item.operation_id AND operation.node_id IS NULL;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM harness.document_catalog WHERE node_id IS NULL)
    OR EXISTS(SELECT 1 FROM harness.document_projection_checkpoints WHERE node_id IS NULL) THEN
    RAISE EXCEPTION 'document metadata requires its original computer assignment before upgrade' USING ERRCODE='23514';
  END IF;
END $$;
ALTER TABLE harness.document_catalog ALTER COLUMN node_id SET NOT NULL;
ALTER TABLE harness.document_projection_checkpoints ALTER COLUMN node_id SET NOT NULL;
ALTER TABLE harness.document_catalog ADD FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id);
ALTER TABLE harness.document_projection_checkpoints ADD FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id);
ALTER TABLE harness.document_operations
  ADD FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
  ADD CONSTRAINT document_operation_computer CHECK(node_id IS NOT NULL) NOT VALID;

DROP INDEX harness.document_catalog_personal_active_path_key;
DROP INDEX harness.document_catalog_project_active_path_key;
DROP INDEX harness.document_catalog_personal_incarnation_key;
DROP INDEX harness.document_catalog_project_incarnation_key;
DROP INDEX harness.document_projection_personal_scope_key;
DROP INDEX harness.document_projection_project_scope_key;
CREATE UNIQUE INDEX document_catalog_personal_active_path_key ON harness.document_catalog(organization_id,node_id,scope_user_id,runtime_doc_id)
  WHERE scope_kind='personal' AND state='active';
CREATE UNIQUE INDEX document_catalog_project_active_path_key ON harness.document_catalog(organization_id,node_id,scope_project_id,runtime_doc_id)
  WHERE scope_kind='project' AND state='active';
CREATE UNIQUE INDEX document_catalog_personal_incarnation_key ON harness.document_catalog(organization_id,node_id,scope_user_id,runtime_incarnation_id)
  WHERE scope_kind='personal' AND runtime_incarnation_id IS NOT NULL;
CREATE UNIQUE INDEX document_catalog_project_incarnation_key ON harness.document_catalog(organization_id,node_id,scope_project_id,runtime_incarnation_id)
  WHERE scope_kind='project' AND runtime_incarnation_id IS NOT NULL;
CREATE UNIQUE INDEX document_projection_personal_scope_key ON harness.document_projection_checkpoints(organization_id,node_id,scope_user_id)
  WHERE scope_kind='personal';
CREATE UNIQUE INDEX document_projection_project_scope_key ON harness.document_projection_checkpoints(organization_id,node_id,scope_project_id)
  WHERE scope_kind='project';
CREATE INDEX document_catalog_node_page ON harness.document_catalog(organization_id,node_id,modified_at_ms DESC,id);
CREATE INDEX document_operations_node_page ON harness.document_operations(organization_id,node_id,created_at DESC,id);

CREATE FUNCTION harness.validate_document_computer_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scope_kind='personal' AND NOT EXISTS(SELECT 1 FROM harness.node_user_accounts account
    WHERE account.organization_id=NEW.organization_id AND account.node_id=NEW.node_id AND account.user_id=NEW.scope_user_id)
    OR NEW.scope_kind='project' AND NOT EXISTS(SELECT 1 FROM harness.instances instance
      WHERE instance.organization_id=NEW.organization_id AND instance.assigned_node_id=NEW.node_id AND instance.project_id=NEW.scope_project_id) THEN
    RAISE EXCEPTION 'document scope is not provisioned on this computer' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_document_computer_scope BEFORE INSERT OR UPDATE OF scope_kind,scope_user_id,scope_project_id,node_id
  ON harness.document_catalog FOR EACH ROW EXECUTE FUNCTION harness.validate_document_computer_scope();
CREATE TRIGGER validate_document_computer_scope BEFORE INSERT OR UPDATE OF scope_kind,scope_user_id,scope_project_id,node_id
  ON harness.document_projection_checkpoints FOR EACH ROW EXECUTE FUNCTION harness.validate_document_computer_scope();

CREATE FUNCTION harness.preserve_document_computer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.node_id IS DISTINCT FROM OLD.node_id THEN
    RAISE EXCEPTION 'document computer is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_document_computer BEFORE UPDATE ON harness.document_catalog FOR EACH ROW EXECUTE FUNCTION harness.preserve_document_computer();
CREATE TRIGGER preserve_document_computer BEFORE UPDATE ON harness.document_projection_checkpoints FOR EACH ROW EXECUTE FUNCTION harness.preserve_document_computer();
CREATE TRIGGER preserve_document_computer BEFORE UPDATE ON harness.document_operations FOR EACH ROW EXECUTE FUNCTION harness.preserve_document_computer();
