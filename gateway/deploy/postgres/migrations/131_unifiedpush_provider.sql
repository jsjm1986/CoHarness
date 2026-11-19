-- UnifiedPush device registrations: extend the provider check written by 010.
ALTER TABLE harness.push_devices
  DROP CONSTRAINT push_devices_provider_check,
  ADD CONSTRAINT push_devices_provider_check
    CHECK (provider IN ('fcm', 'jpush', 'unifiedpush'));
