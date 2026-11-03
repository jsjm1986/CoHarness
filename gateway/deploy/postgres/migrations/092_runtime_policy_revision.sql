-- Clearing an account override retains its revision so an older editor cannot overwrite a recreated policy.
ALTER TABLE harness.runtime_allocation_policies ADD COLUMN override_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE harness.runtime_allocation_policies ADD CONSTRAINT organization_runtime_policy_enabled
  CHECK(user_id IS NOT NULL OR override_enabled);
