-- Clock round-trip bounds preserve observation order between independent coordinators.
ALTER TABLE harness.node_resource_state ADD COLUMN sampled_before timestamptz;
UPDATE harness.node_resource_state SET credits=0,sampled_at=NULL,valid_until=NULL;
ALTER TABLE harness.node_resource_state ADD CONSTRAINT node_resource_observation_bounds CHECK (
  (sampled_at IS NULL AND sampled_before IS NULL)
  OR (sampled_at IS NOT NULL AND sampled_before IS NOT NULL AND sampled_at<=sampled_before)
);
