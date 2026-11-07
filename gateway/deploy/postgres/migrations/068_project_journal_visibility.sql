-- Synthesized prose must be regenerated when its shared source set changes.
ALTER TABLE harness.project_journal ADD COLUMN invalidated_at timestamptz;
UPDATE harness.project_journal SET invalidated_at=now();
UPDATE harness.project_journal_state SET watermark_ts=NULL,watermark_session=NULL,watermark_seq=NULL,
  generating_since=NULL,generation_id=NULL,last_run_at=NULL,last_error=NULL,updated_at=now();

CREATE FUNCTION harness.invalidate_project_journal_sources() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_project uuid;
  new_project uuid;
BEGIN
  IF OLD.id=OLD.root_session_id AND OLD.visibility='project' AND OLD.status<>'deleted' THEN
    old_project := OLD.project_id;
  END IF;
  IF TG_OP='UPDATE' AND NEW.id=NEW.root_session_id AND NEW.visibility='project' AND NEW.status<>'deleted' THEN
    new_project := NEW.project_id;
  END IF;
  IF old_project IS NOT DISTINCT FROM new_project THEN RETURN NULL; END IF;
  -- Publishers lock source rows, then state, then journal entries in the same order.
  UPDATE harness.project_journal_state SET watermark_ts=NULL,watermark_session=NULL,watermark_seq=NULL,
    generating_since=NULL,generation_id=NULL,last_run_at=NULL,last_error=NULL,updated_at=now()
    WHERE organization_id=OLD.organization_id AND project_id IN (old_project,new_project);
  UPDATE harness.project_journal SET invalidated_at=now(),updated_at=now()
    WHERE organization_id=OLD.organization_id AND project_id IN (old_project,new_project) AND invalidated_at IS NULL;
  RETURN NULL;
END;
$$;
CREATE TRIGGER project_journal_source_visibility
  AFTER UPDATE OF visibility,status,project_id,root_session_id OR DELETE ON harness.conversation_sessions
  FOR EACH ROW EXECUTE FUNCTION harness.invalidate_project_journal_sources();
