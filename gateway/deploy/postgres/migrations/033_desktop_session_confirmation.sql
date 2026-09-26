-- Human confirmation cannot survive a runtime replacement or a qualification revision.
CREATE TABLE harness.desktop_session_confirmations (
  organization_id uuid NOT NULL,
  runtime_kind text NOT NULL,
  runtime_public_id bigint NOT NULL,
  session_id text NOT NULL,
  node_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  desktop text NOT NULL CHECK (octet_length(desktop) BETWEEN 1 AND 256),
  user_id uuid NOT NULL,
  user_policy_revision bigint NOT NULL CHECK (user_policy_revision > 0),
  project_policy_revision bigint NOT NULL CHECK (project_policy_revision >= 0),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,runtime_kind,runtime_public_id,session_id,node_id,generation,desktop,user_id),
  FOREIGN KEY (organization_id,runtime_kind,runtime_public_id,session_id)
    REFERENCES harness.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id) ON DELETE CASCADE,
  FOREIGN KEY (node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
  FOREIGN KEY (user_id,organization_id) REFERENCES harness.users(id,organization_id)
);
