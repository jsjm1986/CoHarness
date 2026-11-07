-- PostgreSQL text excludes NUL; only affected rows retain the original NUL-separated pieces.
ALTER TABLE harness.conversation_search ADD COLUMN content_nul_parts text[],
  ADD CONSTRAINT conversation_search_nul_text CHECK(content_nul_parts IS NULL OR (
    array_ndims(content_nul_parts)=1 AND array_lower(content_nul_parts,1)=1
    AND cardinality(content_nul_parts)>=2 AND array_position(content_nul_parts,NULL) IS NULL
    AND content=array_to_string(content_nul_parts,E'\n')));
ALTER TABLE harness.conversation_archive_search ADD COLUMN content_nul_parts text[],
  ADD CONSTRAINT conversation_archive_search_nul_text CHECK(content_nul_parts IS NULL OR (
    array_ndims(content_nul_parts)=1 AND array_lower(content_nul_parts,1)=1
    AND cardinality(content_nul_parts)>=2 AND array_position(content_nul_parts,NULL) IS NULL
    AND content=array_to_string(content_nul_parts,E'\n')));

-- Native json carries escaped NUL without converting it to PostgreSQL text or jsonb.
CREATE FUNCTION harness.conversation_search_text(content text, nul_parts text[], maximum integer DEFAULT NULL)
RETURNS json LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE result json;
BEGIN
  IF maximum<0 THEN RAISE EXCEPTION 'search excerpt length must be nonnegative' USING ERRCODE='22023'; END IF;
  IF nul_parts IS NULL THEN
    RETURN to_json(CASE WHEN maximum IS NULL THEN content ELSE left(content,maximum) END);
  END IF;
  WITH pieces AS (
    SELECT piece,ordinality,COALESCE(sum(char_length(piece)+1) OVER (
      ORDER BY ordinality ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) start_at
    FROM unnest(CASE WHEN maximum IS NULL OR maximum>=cardinality(nul_parts)
      THEN nul_parts ELSE nul_parts[1:maximum+1] END) WITH ORDINALITY item(piece,ordinality)
  ), encoded AS (
    SELECT ordinality,to_json(CASE WHEN maximum IS NULL THEN piece
      ELSE left(piece,GREATEST(maximum-start_at,0)::integer) END)::text value
    FROM pieces WHERE maximum IS NULL OR start_at<=maximum
  )
  SELECT ('"'||string_agg(substring(value FROM 2 FOR char_length(value)-2),E'\\u0000' ORDER BY ordinality)||'"')::json
    INTO result FROM encoded;
  RETURN result;
END $$;

-- Each query piece must match consecutive stored pieces; empty pieces preserve adjacent NULs.
CREATE FUNCTION harness.conversation_search_literal(content text, nul_parts text[], patterns text[])
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXISTS(
    SELECT 1 FROM generate_subscripts(COALESCE(nul_parts,ARRAY[content]),1) start_at
    WHERE start_at+cardinality(patterns)-1<=cardinality(COALESCE(nul_parts,ARRAY[content]))
      AND NOT EXISTS(
        SELECT 1 FROM generate_subscripts(patterns,1) part
        WHERE NOT ((COALESCE(nul_parts,ARRAY[content]))[start_at+part-1] ILIKE patterns[part])
      )
  )
$$;

-- The migration runner fills the version-one fields in this same transaction before recording100.
ALTER TABLE harness.conversation_events ADD COLUMN query_fields jsonb,
  ADD CONSTRAINT conversation_event_query_fields CHECK(query_fields IS NOT NULL AND jsonb_typeof(query_fields)='object') NOT VALID;

DROP TRIGGER preserve_project_journal_request_session ON harness.project_journal_requests;
ALTER TABLE harness.project_journal ALTER COLUMN content TYPE json USING content::json;
ALTER TABLE harness.project_journal_requests DROP CONSTRAINT project_journal_request_session_identity,
  ALTER COLUMN request TYPE json USING request::json,
  ALTER COLUMN request_session TYPE json USING request_session::json;

-- Only structural fields are inspected here; original free text remains in the native-json columns.
CREATE FUNCTION harness.project_journal_session_identity(artifact json, request_id uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (jsonb_typeof(value)='object' AND jsonb_typeof(value->'header')='object'
    AND value->'header'->>'id'=request_id::text AND jsonb_typeof(value->'header'->'version')='number'
    AND value->>'inheritedEventCount'='0' AND jsonb_typeof(value->'events')='array') IS TRUE
  FROM (SELECT replace(artifact::text,'\u0000','\u0020')::jsonb value) parsed
$$;
ALTER TABLE harness.project_journal_requests ADD CONSTRAINT project_journal_request_session_identity CHECK (
  request_session IS NULL OR harness.project_journal_session_identity(request_session,request_id));
CREATE OR REPLACE FUNCTION harness.preserve_project_journal_request_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.request_session IS NOT NULL AND NEW.request_session::text IS DISTINCT FROM OLD.request_session::text THEN
    RAISE EXCEPTION 'committed progress request Session is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_project_journal_request_session BEFORE UPDATE OF request_session ON harness.project_journal_requests
  FOR EACH ROW EXECUTE FUNCTION harness.preserve_project_journal_request_session();
