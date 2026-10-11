-- Successful `api` rows record one transport fact per proxied /api/* request
-- (RPC polling), which drowned the administrator-facing operation log at a
-- ~99.8% noise share. Successful rows are dropped; `status_code >= 400`
-- failures stay because they are the only forensically useful subset.
DELETE FROM harness.audit_events
WHERE action = 'api' AND (status_code IS NULL OR status_code < 400);
