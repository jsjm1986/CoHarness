-- Only the owning physical database can certify its retired writer or staged recovery. Neither record starts a Runtime.
CREATE TABLE node_content.recovery_source_fences (
  operation_id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, runtime_id uuid NOT NULL,
  source_node_id uuid NOT NULL, source_volume_id uuid NOT NULL, source_epoch bigint NOT NULL CHECK(source_epoch>0),
  destination_node_id uuid NOT NULL, destination_volume_id uuid NOT NULL, destination_epoch bigint NOT NULL,
  generation bigint NOT NULL CHECK(generation>0), stop_operation_id uuid NOT NULL, point_id uuid NOT NULL,
  revision bigint NOT NULL CHECK(revision>=0), schedule_digest text NOT NULL CHECK(schedule_digest ~ '^[a-f0-9]{64}$'),
  files_digest text NOT NULL CHECK(files_digest ~ '^[a-f0-9]{64}$'), fenced_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(organization_id,runtime_id),
  FOREIGN KEY(organization_id,runtime_id) REFERENCES node_content.spaces(organization_id,runtime_id),
  CHECK(source_node_id<>destination_node_id AND source_volume_id<>destination_volume_id AND destination_epoch=source_epoch+1)
);
CREATE TABLE node_content.recovery_candidates (
  operation_id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, runtime_id uuid NOT NULL,
  source_node_id uuid NOT NULL, source_volume_id uuid NOT NULL, source_epoch bigint NOT NULL CHECK(source_epoch>0),
  destination_node_id uuid NOT NULL, destination_volume_id uuid NOT NULL, destination_epoch bigint NOT NULL,
  point_id uuid NOT NULL, manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),
  schedule_digest text NOT NULL CHECK(schedule_digest ~ '^[a-f0-9]{64}$'),
  target_files_digest text NOT NULL CHECK(target_files_digest ~ '^[a-f0-9]{64}$'),protected_roots jsonb NOT NULL CHECK(jsonb_typeof(protected_roots)='array'),
  files_digest text NOT NULL CHECK(files_digest ~ '^[a-f0-9]{64}$'),phase text NOT NULL DEFAULT 'loading' CHECK(phase IN ('loading','verified','active')), verified_at timestamptz, activated_at timestamptz,
  UNIQUE(organization_id,runtime_id), CHECK(source_node_id<>destination_node_id AND source_volume_id<>destination_volume_id AND destination_epoch=source_epoch+1)
);
CREATE FUNCTION node_content.keep_project_fence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'A retired physical project writer cannot be restored in place'; END $$;
CREATE TRIGGER keep_project_fence BEFORE UPDATE OR DELETE ON node_content.recovery_source_fences FOR EACH ROW EXECUTE FUNCTION node_content.keep_project_fence();
ALTER TABLE node_content.spaces DROP CONSTRAINT spaces_publication_state_check;
ALTER TABLE node_content.spaces ADD CONSTRAINT spaces_publication_state_check CHECK(publication_state IN ('staging','sealed','published','retired'));
CREATE OR REPLACE FUNCTION node_content.guard_space_assignment() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.publication_state='retired' THEN RAISE EXCEPTION 'The physical project writer has been retired'; END IF;
  IF NEW.publication_state='retired' THEN
    IF OLD.publication_state<>'published' OR (NEW.organization_id,NEW.project_id,NEW.runtime_id,NEW.node_id,NEW.volume_id)
      IS DISTINCT FROM (OLD.organization_id,OLD.project_id,OLD.runtime_id,OLD.node_id,OLD.volume_id) OR NOT EXISTS(
        SELECT FROM node_content.recovery_source_fences f WHERE f.organization_id=OLD.organization_id AND f.project_id=OLD.project_id
        AND f.runtime_id=OLD.runtime_id AND f.source_node_id=OLD.node_id AND f.source_volume_id=OLD.volume_id AND f.source_epoch=OLD.writer_epoch
        AND f.destination_epoch=NEW.writer_epoch AND f.revision=OLD.revision)
    THEN RAISE EXCEPTION 'The physical project retirement is uncertified'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.organization_id,NEW.project_id,NEW.runtime_id,NEW.node_id,NEW.volume_id,NEW.writer_epoch)
     IS DISTINCT FROM (OLD.organization_id,OLD.project_id,OLD.runtime_id,OLD.node_id,OLD.volume_id,OLD.writer_epoch)
     OR (OLD.publication_state='published' AND NEW.publication_state<>'published') THEN RAISE EXCEPTION 'published space requires fenced retirement'; END IF;
  RETURN NEW;
END $$;
