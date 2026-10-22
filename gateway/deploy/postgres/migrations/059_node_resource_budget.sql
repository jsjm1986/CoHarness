-- Durable node-wide execution reservations survive Gateway process restarts.
CREATE TABLE harness.node_resource_state (
  organization_id uuid NOT NULL,
  node_id uuid NOT NULL,
  limits jsonb NOT NULL,
  pressure jsonb,
  sampled_at timestamptz,
  valid_until timestamptz,
  credits integer NOT NULL DEFAULT 0,
  next_turn bigint NOT NULL DEFAULT 0,
  admitted bigint NOT NULL DEFAULT 0,
  rejected bigint NOT NULL DEFAULT 0,
  completed bigint NOT NULL DEFAULT 0,
  cancelled bigint NOT NULL DEFAULT 0,
  timed_out bigint NOT NULL DEFAULT 0,
  reclaimed bigint NOT NULL DEFAULT 0,
  wait_ms_total double precision NOT NULL DEFAULT 0,
  wait_ms_max double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id,node_id),
  FOREIGN KEY (node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id)
);

-- A monotonic sequence fences delayed duplicate requests after their rows are removed.
CREATE TABLE harness.node_resource_runtimes (
  organization_id uuid NOT NULL,
  node_id uuid NOT NULL,
  runtime_kind text NOT NULL CHECK (runtime_kind IN ('user','project')),
  runtime_public_id bigint NOT NULL,
  generation bigint NOT NULL,
  last_sequence bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id,node_id,runtime_kind,runtime_public_id,generation),
  FOREIGN KEY (organization_id,node_id) REFERENCES harness.node_resource_state(organization_id,node_id)
);

CREATE TABLE harness.node_resource_requests (
  organization_id uuid NOT NULL,
  node_id uuid NOT NULL,
  runtime_kind text NOT NULL,
  runtime_public_id bigint NOT NULL,
  generation bigint NOT NULL,
  sequence bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('model','process')),
  actor_public_id bigint NOT NULL,
  project_public_id bigint NOT NULL DEFAULT 0,
  session_id text,
  fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','active','uncertain')),
  user_turn bigint NOT NULL,
  project_turn bigint NOT NULL,
  queued_bytes integer NOT NULL CHECK (queued_bytes>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline timestamptz NOT NULL,
  granted_at timestamptz,
  PRIMARY KEY (organization_id,node_id,runtime_kind,runtime_public_id,generation,sequence),
  FOREIGN KEY (organization_id,node_id,runtime_kind,runtime_public_id,generation)
    REFERENCES harness.node_resource_runtimes(organization_id,node_id,runtime_kind,runtime_public_id,generation)
);
CREATE INDEX node_resource_schedule ON harness.node_resource_requests
  (organization_id,node_id,kind,user_turn,project_turn,sequence) WHERE state='queued';
