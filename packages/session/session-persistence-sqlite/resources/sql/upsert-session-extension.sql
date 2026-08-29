INSERT INTO session_extensions (session_id, draft)
SELECT id, ?
FROM sessions
WHERE session_key = ?
ON CONFLICT(session_id) DO UPDATE SET draft = excluded.draft;
