-- Utility model inputs use the released Session vocabulary without joining member conversations.
ALTER TABLE harness.project_journal_requests ADD COLUMN request_session jsonb;
ALTER TABLE harness.project_journal_requests ADD CONSTRAINT project_journal_request_session_identity CHECK (
  request_session IS NULL OR (
    jsonb_typeof(request_session)='object'
    AND jsonb_typeof(request_session->'header')='object'
    AND request_session->'header'->>'id'=request_id::text
    AND jsonb_typeof(request_session->'header'->'version')='number'
    AND request_session->>'inheritedEventCount'='0'
    AND jsonb_typeof(request_session->'events')='array'
  ) IS TRUE
);

CREATE FUNCTION harness.preserve_project_journal_request_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.request_session IS NOT NULL AND NEW.request_session IS DISTINCT FROM OLD.request_session THEN
    RAISE EXCEPTION 'committed progress request Session is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_project_journal_request_session BEFORE UPDATE OF request_session ON harness.project_journal_requests
  FOR EACH ROW EXECUTE FUNCTION harness.preserve_project_journal_request_session();
