SELECT s.session_key AS id, s.version, s.created_at, s.cwd, s.parent_session, s.seed_length, s.origin,
       s.delegation_depth, s.agent_preset, COALESCE(x.draft, 0) AS draft,
       s.incarnation, s.revision
FROM sessions AS s
LEFT JOIN session_extensions AS x ON x.session_id = s.id
WHERE s.session_key = ?;
