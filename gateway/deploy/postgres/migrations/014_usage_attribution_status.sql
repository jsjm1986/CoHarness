-- Keep billing ownership (user_id/project_id) separate from the verified
-- participant who initiated a project request. Existing rows remain historical
-- and are intentionally not assigned to a user.
ALTER TABLE harness.model_usage
  ADD COLUMN actor_user_id uuid,
  ADD COLUMN pricing_status text NOT NULL DEFAULT 'historical-unknown'
    CHECK (pricing_status IN ('priced','unpriced','configured-zero','historical-unknown')),
  ADD CONSTRAINT model_usage_actor_requires_project
    CHECK (actor_user_id IS NULL OR project_id IS NOT NULL),
  ADD CONSTRAINT model_usage_actor_id_organization_id_fkey
    FOREIGN KEY (actor_user_id, organization_id)
    REFERENCES harness.users(id, organization_id);

CREATE INDEX model_usage_actor_time
  ON harness.model_usage(actor_user_id, occurred_at DESC)
  WHERE actor_user_id IS NOT NULL;
