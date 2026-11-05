ALTER TABLE node_content.conversation_append_batches ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE node_content.migration_snapshots (
  id uuid PRIMARY KEY,job_id uuid NOT NULL,organization_id uuid NOT NULL,runtime_id uuid NOT NULL,project_id uuid NOT NULL,
  writer_epoch bigint NOT NULL,source_revision bigint NOT NULL,manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
  verified boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,runtime_id,project_id) REFERENCES node_content.spaces(organization_id,runtime_id,project_id),
  UNIQUE(job_id,source_revision)
);
CREATE TABLE node_content.migration_batches (
  snapshot_id uuid NOT NULL REFERENCES node_content.migration_snapshots(id) ON DELETE CASCADE,
  relation text NOT NULL,batch integer NOT NULL,body text NOT NULL,digest bytea NOT NULL,
  PRIMARY KEY(snapshot_id,relation,batch)
);
ALTER TABLE node_content.spaces ADD COLUMN publication_state text NOT NULL DEFAULT 'staging'
  CHECK(publication_state IN ('staging','sealed','published'));
ALTER TABLE node_content.migration_snapshots ADD COLUMN materialized boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX one_materialized_copy ON node_content.migration_snapshots(organization_id,runtime_id) WHERE materialized;
CREATE TABLE node_content.migration_domain_receipts (
  snapshot_id uuid NOT NULL REFERENCES node_content.migration_snapshots(id) ON DELETE CASCADE,
  domain text NOT NULL,source_revision bigint NOT NULL,digest bytea NOT NULL CHECK(octet_length(digest)=32),
  records bigint NOT NULL CHECK(records>=0),PRIMARY KEY(snapshot_id,domain)
);
CREATE FUNCTION node_content.guard_space_assignment() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (NEW.organization_id,NEW.project_id,NEW.runtime_id,NEW.node_id,NEW.volume_id,NEW.writer_epoch)
      IS DISTINCT FROM (OLD.organization_id,OLD.project_id,OLD.runtime_id,OLD.node_id,OLD.volume_id,OLD.writer_epoch)
      OR (OLD.publication_state='published' AND NEW.publication_state<>'published') THEN
    RAISE EXCEPTION 'published space requires fenced retirement';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_space_assignment BEFORE UPDATE ON node_content.spaces FOR EACH ROW EXECUTE FUNCTION node_content.guard_space_assignment();
CREATE OR REPLACE FUNCTION node_content.preserve_execution_witness() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' AND EXISTS(SELECT FROM node_content.spaces s WHERE s.organization_id=OLD.organization_id AND s.runtime_id=OLD.runtime_id AND s.publication_state='staging') THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME='execution_inputs' AND TG_OP='UPDATE' THEN
    IF OLD.entered_at IS NULL AND NEW.entered_at IS NOT NULL AND (to_jsonb(OLD)-'entered_at')=(to_jsonb(NEW)-'entered_at') THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'execution witness is immutable';
END $$;
