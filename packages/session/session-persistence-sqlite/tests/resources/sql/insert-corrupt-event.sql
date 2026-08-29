WITH target AS (SELECT id FROM sessions WHERE session_key = ?)
INSERT INTO events (session_id, seq, type, time, data, is_packed)
SELECT id, ?, ?, ?, ?, CASE WHEN ? = 0 THEN 1 ELSE 0 END
FROM target;
