-- The selected profile composition belongs to the project. The control instance stores its applied revision only.
ALTER TABLE node_content.spaces ADD COLUMN plugin_revision bigint NOT NULL DEFAULT 0 CHECK(plugin_revision>=0);
CREATE TABLE node_content.project_file_anchors (
  organization_id uuid NOT NULL,project_id uuid NOT NULL,runtime_id uuid NOT NULL,owner text NOT NULL CHECK(owner IN ('workspace','runtime','storage')),
  path text NOT NULL,anchor_path text NOT NULL,device text NOT NULL,inode text NOT NULL,missing boolean NOT NULL,
  PRIMARY KEY(organization_id,runtime_id,owner),
  FOREIGN KEY(organization_id,runtime_id,project_id) REFERENCES node_content.spaces(organization_id,runtime_id,project_id)
);
CREATE TABLE node_content.plugin_states (
  organization_id uuid NOT NULL,project_id uuid NOT NULL,runtime_id uuid NOT NULL,user_id uuid CHECK(user_id IS NULL),
  entries jsonb NOT NULL CHECK(jsonb_typeof(entries)='array'),bundles jsonb NOT NULL CHECK(jsonb_typeof(bundles)='array'),
  revision bigint NOT NULL CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,runtime_id),
  FOREIGN KEY(organization_id,runtime_id,project_id) REFERENCES node_content.spaces(organization_id,runtime_id,project_id)
);
ALTER TABLE node_content.conversation_archive_records ADD COLUMN legacy_unassigned boolean NOT NULL DEFAULT false CHECK(NOT legacy_unassigned);
ALTER TABLE node_content.content_files ALTER COLUMN session_id DROP NOT NULL,
  ADD COLUMN owner_user_id uuid,ADD COLUMN kind text NOT NULL CHECK(kind IN ('attachment','spill','artifact','tool-output')),
  ADD COLUMN sha256 char(64) NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),ADD COLUMN byte_length bigint NOT NULL CHECK(byte_length>=0),
  ADD COLUMN media_type text NOT NULL,ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD FOREIGN KEY(organization_id,runtime_id) REFERENCES node_content.spaces(organization_id,runtime_id);
