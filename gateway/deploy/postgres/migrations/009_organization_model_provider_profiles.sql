ALTER TABLE harness.model_providers
  ADD COLUMN profile jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(profile) = 'object');
