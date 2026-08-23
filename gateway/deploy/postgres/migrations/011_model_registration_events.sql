CREATE TABLE harness.model_registration_events (
  event_id text NOT NULL,
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  provider_key text NOT NULL,
  model_key text,
  action text NOT NULL CHECK (action IN (
    'provider-created','provider-modified','provider-deleted',
    'model-created','model-modified','model-deleted'
  )),
  scope text NOT NULL CHECK (scope = 'personal'),
  PRIMARY KEY (organization_id, event_id),
  FOREIGN KEY (user_id, organization_id) REFERENCES harness.users(id, organization_id) ON DELETE CASCADE,
  CHECK ((action LIKE 'provider-%' AND model_key IS NULL)
    OR (action LIKE 'model-%' AND model_key IS NOT NULL AND length(model_key) > 0))
);

CREATE INDEX model_registration_events_user_time
  ON harness.model_registration_events(organization_id, user_id, occurred_at DESC);
CREATE INDEX model_registration_events_route_time
  ON harness.model_registration_events(organization_id, provider_key, model_key, occurred_at DESC);
