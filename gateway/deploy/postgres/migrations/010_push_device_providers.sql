ALTER TABLE harness.push_devices
  ADD COLUMN provider text NOT NULL DEFAULT 'fcm'
    CHECK (provider IN ('fcm', 'jpush'));

ALTER TABLE harness.push_devices
  DROP CONSTRAINT IF EXISTS push_devices_organization_id_token_key;

ALTER TABLE harness.push_devices
  ADD CONSTRAINT push_devices_organization_provider_token_key
    UNIQUE (organization_id, provider, token);

CREATE INDEX push_devices_provider
  ON harness.push_devices(organization_id, user_id, provider, updated_at DESC);
