-- Request evidence and billing survive a Gateway crash without inventing a chat participant.
CREATE TABLE harness.project_journal_requests (
  organization_id uuid NOT NULL,
  node_id uuid NOT NULL,
  project_id uuid NOT NULL,
  project_public_id bigint NOT NULL CHECK (project_public_id>0),
  request_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE,
  actor_public_id bigint NOT NULL CHECK (actor_public_id>=0),
  occurred_at timestamptz NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  credential_source text NOT NULL CHECK (credential_source IN ('organization','project')),
  request jsonb NOT NULL,
  response text,
  completed boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'missing-usage' CHECK (status IN ('succeeded','failed','cancelled','missing-usage','denied')),
  input_tokens bigint CHECK (input_tokens>=0),
  output_tokens bigint CHECK (output_tokens>=0),
  cache_read_tokens bigint CHECK (cache_read_tokens>=0),
  cache_write_tokens bigint CHECK (cache_write_tokens>=0),
  delivered_at timestamptz,
  FOREIGN KEY (node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
  FOREIGN KEY (organization_id,project_id) REFERENCES harness.projects(organization_id,id)
);
CREATE INDEX project_journal_request_delivery ON harness.project_journal_requests(organization_id,node_id,occurred_at,request_id)
  WHERE delivered_at IS NULL;
