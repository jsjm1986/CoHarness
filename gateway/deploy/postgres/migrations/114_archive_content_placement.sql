-- Reject stale archive publishers and advance a registered snapshot's watermark on archive-only changes.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversation_archive_records','conversation_archive_search','content_files'] LOOP
    EXECUTE format('CREATE TRIGGER archive_source_insert AFTER INSERT ON harness.%I REFERENCING NEW TABLE AS incoming FOR EACH STATEMENT EXECUTE FUNCTION harness.refuse_remote_session_payload()',t);
    EXECUTE format('CREATE TRIGGER archive_source_update AFTER UPDATE ON harness.%I REFERENCING NEW TABLE AS incoming FOR EACH STATEMENT EXECUTE FUNCTION harness.refuse_remote_session_payload()',t);
    EXECUTE format('CREATE TRIGGER archive_source_delete AFTER DELETE ON harness.%I REFERENCING OLD TABLE AS incoming FOR EACH STATEMENT EXECUTE FUNCTION harness.refuse_remote_session_payload()',t);
  END LOOP;
END $$;
CREATE FUNCTION harness.guard_archive_work() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  UPDATE harness.project_content_copy_jobs j SET source_revision=source_revision+1 WHERE NOT published AND EXISTS(
    SELECT FROM incoming c JOIN harness.conversation_archive_records a USING(organization_id,archive_id)
    WHERE (a.organization_id,a.runtime_id)=(j.organization_id,j.runtime_id));
  IF EXISTS(SELECT FROM incoming c JOIN harness.conversation_archive_records a USING(organization_id,archive_id)
    JOIN harness.project_content_placement b ON (b.organization_id,b.runtime_id)=(a.organization_id,a.runtime_id)) THEN
    RAISE EXCEPTION 'Archive work belongs to its assigned content volume' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversation_archive_commands','conversation_archive_file_cleanup'] LOOP
    EXECUTE format('CREATE TRIGGER archive_work_insert AFTER INSERT ON harness.%I REFERENCING NEW TABLE AS incoming FOR EACH STATEMENT EXECUTE FUNCTION harness.guard_archive_work()',t);
    EXECUTE format('CREATE TRIGGER archive_work_update AFTER UPDATE ON harness.%I REFERENCING NEW TABLE AS incoming FOR EACH STATEMENT EXECUTE FUNCTION harness.guard_archive_work()',t);
    EXECUTE format('CREATE TRIGGER archive_work_delete AFTER DELETE ON harness.%I REFERENCING OLD TABLE AS incoming FOR EACH STATEMENT EXECUTE FUNCTION harness.guard_archive_work()',t);
  END LOOP;
END $$;
