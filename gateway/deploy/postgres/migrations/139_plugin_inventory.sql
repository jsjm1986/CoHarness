-- Each Runtime reports its observed plugin composition so administrators can
-- inspect every space, including spaces whose composition is only file-driven.
-- The payload is the Runtime's last report; generation fences stale writers.
CREATE TABLE harness.plugin_inventory (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  runtime_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, runtime_id),
  FOREIGN KEY (runtime_id, organization_id) REFERENCES harness.runtime_environments(id, organization_id)
);

-- A content-placed project's inventory lives in its node volume; harness rows
-- for it would diverge, so the same source-of-truth triggers as the other
-- session-payload tables reject or fence these writes.
CREATE TRIGGER require_shared_insert AFTER INSERT ON harness.plugin_inventory
  REFERENCING NEW TABLE AS incoming FOR EACH STATEMENT EXECUTE FUNCTION harness.refuse_remote_session_payload();
CREATE TRIGGER require_shared_update AFTER UPDATE ON harness.plugin_inventory
  REFERENCING NEW TABLE AS incoming FOR EACH STATEMENT EXECUTE FUNCTION harness.refuse_remote_session_payload();
CREATE TRIGGER track_source_delete AFTER DELETE ON harness.plugin_inventory
  REFERENCING OLD TABLE AS incoming FOR EACH STATEMENT EXECUTE FUNCTION harness.refuse_remote_session_payload();
