-- Creator grants support live revocation after the short-lived browser assertion expires.
CREATE TABLE harness.terminal_session_grants (
  grant_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  organization_id uuid NOT NULL,
  node_id uuid NOT NULL,
  runtime_kind text NOT NULL CHECK (runtime_kind IN ('user','project')),
  runtime_public_id bigint NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  session_id text NOT NULL CHECK (octet_length(session_id) BETWEEN 1 AND 256),
  user_id uuid NOT NULL,
  user_policy_revision bigint NOT NULL CHECK (user_policy_revision > 0),
  project_policy_revision bigint NOT NULL CHECK (project_policy_revision >= 0),
  PRIMARY KEY (organization_id,node_id,runtime_kind,runtime_public_id,session_id,user_id),
  FOREIGN KEY (node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id,organization_id) REFERENCES harness.users(id,organization_id) ON DELETE CASCADE
);
