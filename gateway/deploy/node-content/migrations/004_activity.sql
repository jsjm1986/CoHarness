CREATE FUNCTION node_content.human_session_title(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE
      WHEN ltrim(value) LIKE '<goal\_%' ESCAPE '\' THEN NULL
      WHEN ltrim(value) LIKE 'Shared-project attribution for the next message%' THEN NULL
      WHEN ltrim(value) LIKE 'Current runtime context%' THEN NULL
      WHEN ltrim(value) LIKE '[model changed:%' THEN NULL
      ELSE value
    END
$$;
