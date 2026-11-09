CREATE TABLE node_content.composer_drafts (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  runtime_id uuid NOT NULL,
  account_id bigint NOT NULL CHECK (account_id > 0),
  draft_id uuid NOT NULL,
  session_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  body bytea NOT NULL,
  PRIMARY KEY (organization_id, project_id, runtime_id, account_id, draft_id, session_id),
  FOREIGN KEY (organization_id, runtime_id, project_id)
    REFERENCES node_content.spaces(organization_id, runtime_id, project_id)
);
