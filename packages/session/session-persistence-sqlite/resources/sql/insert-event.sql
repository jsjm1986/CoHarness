INSERT INTO events
  (session_id, seq, type, time, data, source_event_seqs, surface_op, is_packed)
SELECT id, ?, ?, ?, ?, ?, ?, ?
FROM sessions
WHERE session_key = ?;
