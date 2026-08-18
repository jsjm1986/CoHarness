CREATE TABLE harness.push_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token text NOT NULL CHECK (length(token) BETWEEN 1 AND 4096),
  platform text NOT NULL CHECK (platform IN ('android')),
  device_id text,
  app_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, token),
  FOREIGN KEY (user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX push_devices_user ON harness.push_devices(organization_id, user_id, updated_at DESC);

CREATE TABLE harness.push_deliveries (
  organization_id uuid NOT NULL,
  session_id text NOT NULL,
  event_seq bigint NOT NULL CHECK (event_seq >= 0),
  device_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, session_id, event_seq, device_id),
  FOREIGN KEY (device_id) REFERENCES harness.push_devices(id) ON DELETE CASCADE
);
CREATE INDEX push_deliveries_pending ON harness.push_deliveries(updated_at)
  WHERE status <> 'sent';
