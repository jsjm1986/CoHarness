DELETE FROM event_extensions
WHERE session_id = (SELECT id FROM sessions WHERE session_key = ?) AND seq >= ?;
