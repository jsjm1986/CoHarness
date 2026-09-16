-- Remove non-human `user`-role search rows and the titles they produced.
--
-- `user/message` events carry a `source.kind`: only `user` means a human
-- authored the text. Plugin- and goal-sourced injections (runtime-context
-- snapshots, shared-project attribution notices, goal wrap-ups) were indexed
-- as `user` rows and fed every search-row title fallback. New writers skip
-- them; this migration repairs the stored rows.

-- Precise pass: join each search row to its stored event payload so every
-- injection source is covered without enumerating content patterns.
-- `conversation_events.event` is `json` text reparsed per access: legacy
-- payloads containing `\u0000` or unpaired-surrogate escapes fail the whole
-- statement, so extraction goes through a guarded helper and those rows fall
-- through to the envelope pass.
CREATE FUNCTION harness.migration025_event_kind(payload json) RETURNS text
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  RETURN COALESCE(payload -> 'data' -> 'source' ->> 'kind', '');
EXCEPTION WHEN OTHERS THEN
  RETURN 'user';
END $$;

DELETE FROM harness.conversation_search search
USING harness.conversation_events event
WHERE event.session_id = search.session_id
  AND event.seq = search.event_seq
  AND event.event_type = 'user/message'
  AND search.role = 'user'
  AND harness.migration025_event_kind(event.event) <> 'user';

DROP FUNCTION harness.migration025_event_kind(json);

-- Envelope pass: rows synced before `conversation_events` existed have no
-- stored event to join, and `conversation_archive_search` never carried
-- event payloads. These durable injection envelopes cannot begin a human
-- prompt, so prefix matching is exact rather than heuristic; `ltrim` matches
-- the application-side trim before prefix comparison.
DELETE FROM harness.conversation_search
WHERE role = 'user' AND (
  ltrim(content) LIKE '<goal\_%' ESCAPE '\'
  OR ltrim(content) LIKE 'Shared-project attribution for the next message%'
  OR ltrim(content) LIKE 'Current runtime context%'
  OR ltrim(content) LIKE '[model changed:%'
);

DELETE FROM harness.conversation_archive_search
WHERE role = 'user' AND (
  ltrim(content) LIKE '<goal\_%' ESCAPE '\'
  OR ltrim(content) LIKE 'Shared-project attribution for the next message%'
  OR ltrim(content) LIKE 'Current runtime context%'
  OR ltrim(content) LIKE '[model changed:%'
);

-- Archive titles are runtime-synced projections, not identity-checked
-- metadata: clearing the injected values lets the next sync pass or the
-- cleaned search fallback re-derive the human text.
UPDATE harness.conversation_archive_records SET title = NULL
WHERE ltrim(title) LIKE '<goal\_%' ESCAPE '\'
   OR ltrim(title) LIKE 'Shared-project attribution for the next message%'
   OR ltrim(title) LIKE 'Current runtime context%'
   OR ltrim(title) LIKE '[model changed:%';

-- `conversation_sessions.title` is part of the immutable header identity
-- (`assertSameHeader`), so injected values must stay in storage and be
-- neutralized where the title is read instead.
CREATE FUNCTION harness.human_session_title(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE
      WHEN ltrim(value) LIKE '<goal\_%' ESCAPE '\' THEN NULL
      WHEN ltrim(value) LIKE 'Shared-project attribution for the next message%' THEN NULL
      WHEN ltrim(value) LIKE 'Current runtime context%' THEN NULL
      WHEN ltrim(value) LIKE '[model changed:%' THEN NULL
      ELSE value
    END
$$;
