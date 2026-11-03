-- Existing active generations have no proof that allocation has not started.
ALTER TABLE harness.instances ADD COLUMN allocation_state text NOT NULL DEFAULT 'unknown'
  CHECK (allocation_state IN ('unknown', 'not-started', 'waiting', 'possible'));

ALTER TABLE harness.node_resource_state ADD COLUMN runtime_starts_admitted bigint NOT NULL DEFAULT 0;
