ALTER TABLE harness.instances
  ADD COLUMN stop_reason text
  CHECK (stop_reason IN ('manual', 'idle', 'shutdown', 'failed', 'access-change'));

-- Older stopped rows have no reliable origin. Require an explicit start once.
UPDATE harness.instances SET stop_reason='manual'
  WHERE desired_state='stopped' OR observed_state IN ('stopped','stopping');
