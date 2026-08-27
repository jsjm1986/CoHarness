-- Keep every document-catalog user reference inside the owning organization.
-- UUIDs are globally unique today, but composite foreign keys make that
-- isolation explicit and prevent a future import or extension from linking a
-- row to a user in another organization.

ALTER TABLE harness.document_catalog
  ADD CONSTRAINT document_catalog_id_organization_key UNIQUE (id, organization_id),
  DROP CONSTRAINT IF EXISTS document_catalog_owner_user_id_fkey,
  DROP CONSTRAINT IF EXISTS document_catalog_lineage_root_id_fkey,
  DROP CONSTRAINT IF EXISTS document_catalog_source_catalog_id_fkey,
  ADD CONSTRAINT document_catalog_owner_user_org_fk
    FOREIGN KEY (owner_user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE SET NULL (owner_user_id),
  ADD CONSTRAINT document_catalog_lineage_org_fk
    FOREIGN KEY (lineage_root_id, organization_id)
    REFERENCES harness.document_catalog(id, organization_id) ON DELETE SET NULL (lineage_root_id),
  ADD CONSTRAINT document_catalog_source_org_fk
    FOREIGN KEY (source_catalog_id, organization_id)
    REFERENCES harness.document_catalog(id, organization_id) ON DELETE SET NULL (source_catalog_id);

ALTER TABLE harness.document_operations
  ADD CONSTRAINT document_operations_id_organization_key UNIQUE (id, organization_id);

ALTER TABLE harness.document_operation_items
  DROP CONSTRAINT IF EXISTS document_operation_items_operation_id_fkey,
  DROP CONSTRAINT IF EXISTS document_operation_items_source_catalog_id_fkey,
  DROP CONSTRAINT IF EXISTS document_operation_items_target_catalog_id_fkey,
  ADD CONSTRAINT document_operation_items_operation_org_fk
    FOREIGN KEY (operation_id, organization_id)
    REFERENCES harness.document_operations(id, organization_id) ON DELETE CASCADE,
  ADD CONSTRAINT document_operation_items_source_catalog_org_fk
    FOREIGN KEY (source_catalog_id, organization_id)
    REFERENCES harness.document_catalog(id, organization_id) ON DELETE SET NULL (source_catalog_id),
  ADD CONSTRAINT document_operation_items_target_catalog_org_fk
    FOREIGN KEY (target_catalog_id, organization_id)
    REFERENCES harness.document_catalog(id, organization_id) ON DELETE SET NULL (target_catalog_id);

ALTER TABLE harness.document_operations
  DROP CONSTRAINT IF EXISTS document_operations_source_user_id_fkey,
  DROP CONSTRAINT IF EXISTS document_operations_source_project_id_fkey,
  DROP CONSTRAINT IF EXISTS document_operations_target_user_id_fkey,
  DROP CONSTRAINT IF EXISTS document_operations_target_project_id_fkey,
  DROP CONSTRAINT IF EXISTS document_operations_actor_user_id_fkey,
  ADD CONSTRAINT document_operations_source_user_org_fk
    FOREIGN KEY (source_user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE SET NULL (source_user_id),
  ADD CONSTRAINT document_operations_source_project_org_fk
    FOREIGN KEY (source_project_id, organization_id)
    REFERENCES harness.projects(id, organization_id) ON DELETE SET NULL (source_project_id),
  ADD CONSTRAINT document_operations_target_user_org_fk
    FOREIGN KEY (target_user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE SET NULL (target_user_id),
  ADD CONSTRAINT document_operations_target_project_org_fk
    FOREIGN KEY (target_project_id, organization_id)
    REFERENCES harness.projects(id, organization_id) ON DELETE SET NULL (target_project_id),
  ADD CONSTRAINT document_operations_actor_user_org_fk
    FOREIGN KEY (actor_user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE SET NULL (actor_user_id);

ALTER TABLE harness.document_history
  DROP CONSTRAINT IF EXISTS document_history_actor_user_id_fkey,
  DROP CONSTRAINT IF EXISTS document_history_catalog_id_fkey,
  DROP CONSTRAINT IF EXISTS document_history_operation_id_fkey,
  ADD CONSTRAINT document_history_catalog_org_fk
    FOREIGN KEY (catalog_id, organization_id)
    REFERENCES harness.document_catalog(id, organization_id) ON DELETE SET NULL (catalog_id),
  ADD CONSTRAINT document_history_operation_org_fk
    FOREIGN KEY (operation_id, organization_id)
    REFERENCES harness.document_operations(id, organization_id) ON DELETE SET NULL (operation_id),
  ADD CONSTRAINT document_history_actor_user_org_fk
    FOREIGN KEY (actor_user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE SET NULL (actor_user_id);

-- The all-scope overview uses literal substring search and modified-time
-- ordering.  Keep those operations index-assisted as the catalog grows.
CREATE INDEX document_catalog_active_modified
  ON harness.document_catalog(organization_id, modified_at_ms DESC, id)
  WHERE state='active';
CREATE INDEX document_catalog_name_trgm
  ON harness.document_catalog USING gin (name gin_trgm_ops)
  WHERE state='active';
CREATE INDEX document_catalog_runtime_doc_id_trgm
  ON harness.document_catalog USING gin (runtime_doc_id gin_trgm_ops)
  WHERE state='active';
