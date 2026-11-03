CREATE TABLE harness.node_agents (
  organization_id uuid NOT NULL,
  node_id uuid PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  credential_hash bytea UNIQUE,
  revoked_at timestamptz,
  platform text CHECK (platform IN ('darwin','linux')),
  architecture text CHECK (architecture IN ('x64','arm64')),
  connection_id uuid,
  connection_epoch bigint NOT NULL DEFAULT 0 CHECK (connection_epoch >= 0),
  lease_expires_at timestamptz,
  last_seen_at timestamptz,
  UNIQUE (node_id, organization_id),
  FOREIGN KEY (node_id, organization_id) REFERENCES harness.compute_nodes(id, organization_id) ON DELETE CASCADE,
  CHECK (credential_hash IS NULL OR octet_length(credential_hash)=32),
  CHECK ((connection_id IS NULL) = (lease_expires_at IS NULL))
);

CREATE TABLE harness.node_agent_enrollments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  node_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash)=32),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  FOREIGN KEY (node_id, organization_id) REFERENCES harness.node_agents(node_id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by, organization_id) REFERENCES harness.users(id, organization_id),
  UNIQUE (node_id, revision)
);
CREATE INDEX node_agent_directory ON harness.node_agents(organization_id,node_id);

-- Agent connectivity does not acknowledge the Gateway maintenance write gate.
-- New agents have no execution admission; their compute_nodes rows stay offline.
