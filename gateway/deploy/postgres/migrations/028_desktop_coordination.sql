-- Interactive-desktop coordination: one durable grant per {node, desktop}
-- resource plus a FIFO queue, fencing sequence, and unavailability state.
-- The desktop-coordinator module owns the state machine; these tables carry
-- the restart-durable records.
CREATE TABLE harness.desktop_resources (
  resource_key text PRIMARY KEY,
  node text NOT NULL,
  desktop text NOT NULL,
  fencing_seq bigint NOT NULL DEFAULT 0,
  queue_seq bigint NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'available',
  state_note text,
  updated_at bigint NOT NULL
);

CREATE TABLE harness.desktop_grants (
  grant_id text PRIMARY KEY,
  resource_key text NOT NULL REFERENCES harness.desktop_resources(resource_key),
  fencing bigint NOT NULL,
  holder_key text NOT NULL,
  holder_json jsonb NOT NULL,
  request_id text NOT NULL,
  state text NOT NULL,
  reason text,
  acquired_at bigint NOT NULL,
  heartbeat_at bigint NOT NULL,
  stopping_at bigint,
  released_at bigint
);
CREATE INDEX desktop_grants_resource ON harness.desktop_grants(resource_key, state);
CREATE INDEX desktop_grants_request ON harness.desktop_grants(resource_key, holder_key, request_id);

CREATE TABLE harness.desktop_queue (
  queue_id text PRIMARY KEY,
  resource_key text NOT NULL REFERENCES harness.desktop_resources(resource_key),
  position bigint NOT NULL,
  holder_key text NOT NULL,
  holder_json jsonb NOT NULL,
  request_id text NOT NULL,
  state text NOT NULL,
  queued_at bigint NOT NULL,
  settled_at bigint,
  grant_id text
);
CREATE INDEX desktop_queue_resource ON harness.desktop_queue(resource_key, state, position);
CREATE INDEX desktop_queue_request ON harness.desktop_queue(resource_key, holder_key, request_id);
