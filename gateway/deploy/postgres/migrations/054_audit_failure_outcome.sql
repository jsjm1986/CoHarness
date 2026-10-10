-- Reclassify durable outcomes whose action name declares the failure: these
-- rows were written without an HTTP status and defaulted to 'success'.
UPDATE harness.audit_events
SET outcome = 'failure'
WHERE outcome = 'success' AND (
  action LIKE '%.failed' OR action LIKE '%.denied' OR action LIKE '%.locked'
  OR action LIKE '%.error' OR action LIKE '%-failed');
