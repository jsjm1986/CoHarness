-- A committed reservation precedes runtime dispatch. Unknown outcomes are never
-- automatically released: retrying an external delivery must not repeat tools.
CREATE TABLE harness.webhook_delivery_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  endpoint_id uuid NOT NULL,
  delivery_id text NOT NULL CHECK (length(delivery_id) BETWEEN 1 AND 256),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  configuration_revision bigint NOT NULL CHECK (configuration_revision > 0),
  node_id uuid NOT NULL,
  execution_user_id uuid NOT NULL,
  runtime_kind text NOT NULL CHECK (runtime_kind IN ('user','project')),
  runtime_public_id bigint NOT NULL CHECK (runtime_public_id > 0),
  state text NOT NULL DEFAULT 'dispatching' CHECK (state IN ('dispatching','submitted','ignored','rejected','unknown')),
  session_id text,
  error_code text,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,endpoint_id,delivery_id),
  FOREIGN KEY (node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
  FOREIGN KEY (execution_user_id,organization_id) REFERENCES harness.users(id,organization_id),
  CHECK ((state='submitted')=(session_id IS NOT NULL)),
  CHECK (session_id IS NULL OR length(session_id) BETWEEN 1 AND 256),
  CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_-]{0,63}$')
);
CREATE INDEX webhook_receipts_recent ON harness.webhook_delivery_receipts(organization_id,endpoint_id,received_at DESC);

CREATE TABLE harness.webhook_intake_windows (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  endpoint_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  accepted integer NOT NULL DEFAULT 0 CHECK (accepted >= 0),
  PRIMARY KEY (organization_id,endpoint_id)
);
