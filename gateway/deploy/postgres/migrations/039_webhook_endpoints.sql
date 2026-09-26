-- Administrator-registered webhook endpoints. The public intake route is the
-- configured endpoint's public id; signature verification, the structured rule,
-- and execution-account binding all live server-side.
CREATE TABLE harness.webhook_endpoints (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  public_id bigint GENERATED ALWAYS AS IDENTITY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  provider text NOT NULL CHECK (provider = 'github'),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 128),
  events text[] NOT NULL CHECK (cardinality(events) <= 64),
  actions text[] NOT NULL CHECK (cardinality(actions) <= 64),
  title_template text NOT NULL CHECK (length(title_template) BETWEEN 1 AND 512),
  prompt_template text NOT NULL CHECK (length(prompt_template) BETWEEN 1 AND 16384),
  workspace_path text NOT NULL CHECK (length(workspace_path) BETWEEN 1 AND 1024),
  agent_preset text NOT NULL CHECK (length(agent_preset) BETWEEN 1 AND 128),
  permission_preset text NOT NULL CHECK (length(permission_preset) BETWEEN 1 AND 128),
  model_provider text CHECK (model_provider IS NULL OR length(model_provider) BETWEEN 1 AND 128),
  model_id text CHECK (model_id IS NULL OR length(model_id) BETWEEN 1 AND 256),
  model_max_tokens integer CHECK (model_max_tokens IS NULL OR model_max_tokens > 0),
  execution_user_id uuid NOT NULL,
  runtime_kind text NOT NULL CHECK (runtime_kind IN ('user','project')),
  runtime_public_id bigint NOT NULL CHECK (runtime_public_id > 0),
  intake_limit integer NOT NULL CHECK (intake_limit > 0),
  intake_window_ms bigint NOT NULL CHECK (intake_window_ms > 0),
  replay_window_ms bigint NOT NULL CHECK (replay_window_ms > 0),
  max_body_bytes integer NOT NULL CHECK (max_body_bytes > 0),
  key_version integer NOT NULL CHECK (key_version > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 0),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, public_id),
  UNIQUE (organization_id, name),
  CHECK ((model_provider IS NULL) = (model_id IS NULL)),
  FOREIGN KEY (execution_user_id, organization_id) REFERENCES harness.users(id, organization_id),
  FOREIGN KEY (created_by, organization_id) REFERENCES harness.users(id, organization_id)
);

-- Receipts retain the verified event so an administrator can redispatch an
-- accepted delivery without re-verifying provider transport.
ALTER TABLE harness.webhook_delivery_receipts
  ADD COLUMN event jsonb;
