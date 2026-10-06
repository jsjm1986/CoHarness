-- Archive reference deletion preserves the record's organization identity.
ALTER TABLE harness.conversation_archive_records
  DROP CONSTRAINT conversation_archive_records_project_id_organization_id_fkey,
  ADD CONSTRAINT conversation_archive_records_project_id_organization_id_fkey
    FOREIGN KEY (project_id, organization_id)
    REFERENCES harness.projects(id, organization_id)
    ON DELETE SET NULL (project_id),
  DROP CONSTRAINT conversation_archive_records_creator_user_id_organization__fkey,
  ADD CONSTRAINT conversation_archive_records_creator_user_id_organization__fkey
    FOREIGN KEY (creator_user_id, organization_id)
    REFERENCES harness.users(id, organization_id)
    ON DELETE SET NULL (creator_user_id),
  DROP CONSTRAINT conversation_archive_records_archived_by_user_id_organizat_fkey,
  ADD CONSTRAINT conversation_archive_records_archived_by_user_id_organizat_fkey
    FOREIGN KEY (archived_by_user_id, organization_id)
    REFERENCES harness.users(id, organization_id)
    ON DELETE SET NULL (archived_by_user_id),
  DROP CONSTRAINT conversation_archive_records_restored_by_user_id_organizat_fkey,
  ADD CONSTRAINT conversation_archive_records_restored_by_user_id_organizat_fkey
    FOREIGN KEY (restored_by_user_id, organization_id)
    REFERENCES harness.users(id, organization_id)
    ON DELETE SET NULL (restored_by_user_id),
  DROP CONSTRAINT conversation_archive_records_trashed_by_user_id_organizati_fkey,
  ADD CONSTRAINT conversation_archive_records_trashed_by_user_id_organizati_fkey
    FOREIGN KEY (trashed_by_user_id, organization_id)
    REFERENCES harness.users(id, organization_id)
    ON DELETE SET NULL (trashed_by_user_id);
