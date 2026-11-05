-- Short-lived, single-use Gateway challenges contain no names, paths, MACs or signing material.
CREATE UNLOGGED TABLE harness.project_name_handoffs (
  challenge_hash bytea PRIMARY KEY CHECK(octet_length(challenge_hash)=32),
  organization_id uuid NOT NULL,
  node_id uuid NOT NULL,
  project_id uuid NOT NULL,
  actor_public_id bigint NOT NULL,
  operation text NOT NULL CHECK(operation IN ('create','rename','reindex')),
  expires_at timestamptz NOT NULL
);
CREATE INDEX project_name_handoffs_expiry ON harness.project_name_handoffs(expires_at);
