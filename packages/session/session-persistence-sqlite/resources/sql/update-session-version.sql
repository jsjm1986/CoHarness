UPDATE sessions
SET version = ?, revision = revision + 1
WHERE session_key = ?;
