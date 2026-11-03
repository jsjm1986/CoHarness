-- Per-source receipts include delayed arrivals and distinguish answers without a log anchor.
CREATE TABLE harness.project_journal_materials (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  session_id text NOT NULL,
  entry_id text NOT NULL,
  receipt bytea NOT NULL CHECK (receipt=pg_catalog.sha256(
    pg_catalog.convert_to(session_id,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to(entry_id,'UTF8'))),
  PRIMARY KEY (organization_id,project_id,receipt),
  FOREIGN KEY (organization_id,project_id) REFERENCES harness.projects(organization_id,id) ON DELETE CASCADE
);
UPDATE harness.project_journal_state SET watermark_ts=NULL,watermark_session=NULL,watermark_seq=NULL,
  generating_since=NULL,generation_id=NULL,last_run_at=NULL,last_error=NULL,updated_at=now();

CREATE OR REPLACE FUNCTION harness.invalidate_project_journal_sources() RETURNS trigger LANGUAGE plpgsql AS $$
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
  UPDATE harness.project_journal_state SET watermark_ts=NULL,watermark_session=NULL,watermark_seq=NULL,
    generating_since=NULL,generation_id=NULL,last_run_at=NULL,last_error=NULL,updated_at=now()
    WHERE organization_id=OLD.organization_id AND project_id IN (old_project,new_project);
  UPDATE harness.project_journal SET invalidated_at=now(),updated_at=now()
    WHERE organization_id=OLD.organization_id AND project_id IN (old_project,new_project) AND invalidated_at IS NULL;
  DELETE FROM harness.project_journal_materials
    WHERE organization_id=OLD.organization_id AND project_id IN (old_project,new_project);
  RETURN NULL;
END;
$$;
