SELECT e.seq, e.type, e.time, e.data, e.source_event_seqs, e.surface_op, e.is_packed,
       x.ignorable
FROM events AS e
JOIN sessions AS s ON s.id = e.session_id
LEFT JOIN event_extensions AS x ON x.session_id = e.session_id AND x.seq = e.seq
WHERE s.session_key = ?
ORDER BY e.seq;
