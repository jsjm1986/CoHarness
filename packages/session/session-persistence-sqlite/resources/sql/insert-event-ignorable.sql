INSERT INTO event_extensions (session_id, seq, ignorable)
SELECT id, ?, 1
FROM sessions
WHERE session_key = ?;
