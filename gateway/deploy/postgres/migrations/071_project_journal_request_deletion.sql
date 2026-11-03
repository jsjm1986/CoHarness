-- Permanent project removal also removes its progress evidence; archival retains it.
ALTER TABLE harness.project_journal_requests
  DROP CONSTRAINT project_journal_requests_organization_id_project_id_fkey,
  ADD CONSTRAINT project_journal_requests_organization_id_project_id_fkey
    FOREIGN KEY (organization_id,project_id) REFERENCES harness.projects(organization_id,id) ON DELETE CASCADE;
