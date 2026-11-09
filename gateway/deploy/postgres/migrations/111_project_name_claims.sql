-- Organization-wide project name equality. Only key fingerprints and keyed equality tags are durable.
CREATE FUNCTION harness.project_name_normalization() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_array(d.datlocprovider,d.datcollate,d.datctype,to_jsonb(d)->>'datlocale',
    current_setting('server_encoding'),d.datcollversion,pg_database_collation_actual_version(d.oid))::text
  FROM pg_database d WHERE d.datname=current_database() AND d.datcollversion IS NOT DISTINCT FROM pg_database_collation_actual_version(d.oid)
    AND EXISTS(SELECT FROM pg_attribute a JOIN pg_collation c ON c.oid=a.attcollation WHERE a.attrelid='harness.projects'::regclass
      AND a.attname='name' AND c.collname='default' AND c.collnamespace='pg_catalog'::regnamespace AND c.collisdeterministic)
$$;
CREATE TABLE harness.project_name_keys(
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),key_id text NOT NULL CHECK(key_id~'^[A-Za-z0-9_.-]{1,64}$'),
  fingerprint text NOT NULL CHECK(fingerprint~'^[0-9a-f]{64}$'),PRIMARY KEY(organization_id,key_id),UNIQUE(organization_id,fingerprint)
);
CREATE TABLE harness.project_name_policies(
  organization_id uuid PRIMARY KEY REFERENCES harness.organizations(id),revision bigint NOT NULL CHECK(revision>0),
  state text NOT NULL CHECK(state IN ('preparing','active')),active_key text NOT NULL,next_key text CHECK(next_key<>active_key),
  normalization text NOT NULL,
  FOREIGN KEY(organization_id,active_key) REFERENCES harness.project_name_keys(organization_id,key_id),
  FOREIGN KEY(organization_id,next_key) REFERENCES harness.project_name_keys(organization_id,key_id)
);
ALTER TABLE harness.project_content_copy_jobs ADD COLUMN publication_xid xid8;
ALTER TABLE harness.projects ADD COLUMN logical_name_revision bigint NOT NULL DEFAULT 1 CHECK(logical_name_revision>0);
ALTER TABLE harness.projects ADD COLUMN logical_name_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE OR REPLACE FUNCTION harness.project_content_key(org uuid,project uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('organizationId',b.organization_id,'projectId',b.project_id,'nodeId',b.node_id,
    'runtimeId',b.runtime_id,'volumeId',b.volume_id,'writerEpoch',b.writer_epoch::text,'nameVersion',p.logical_name_id)
  FROM harness.project_content_placement b JOIN harness.projects p ON p.organization_id=b.organization_id AND p.id=b.project_id
  WHERE b.organization_id=org AND b.project_id=project;
$$;
CREATE TABLE harness.project_name_claims(
  organization_id uuid NOT NULL,project_id uuid NOT NULL,node_id uuid NOT NULL,key_id text NOT NULL,
  mac bytea NOT NULL CHECK(octet_length(mac)=32),name_revision bigint NOT NULL CHECK(name_revision>0),
  PRIMARY KEY(organization_id,project_id,key_id),UNIQUE(organization_id,key_id,mac),
  FOREIGN KEY(project_id,organization_id) REFERENCES harness.projects(id,organization_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
  FOREIGN KEY(organization_id,key_id) REFERENCES harness.project_name_keys(organization_id,key_id)
);
CREATE FUNCTION harness.fence_project_names() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.organization_id::text,1098311));
  IF TG_OP='UPDATE' THEN
    IF OLD.name::text IS DISTINCT FROM NEW.name::text AND EXISTS(SELECT FROM harness.project_content_placement b WHERE b.organization_id=OLD.organization_id AND b.project_id=OLD.id) THEN
      IF NEW.name::text='hgw-project-'||NEW.id::text AND EXISTS(SELECT FROM harness.project_content_copy_jobs j WHERE j.organization_id=NEW.organization_id
        AND j.project_id=NEW.id AND j.published AND j.publication_xid=pg_current_xact_id()) THEN
        NEW.logical_name_revision=OLD.logical_name_revision; NEW.logical_name_id=OLD.logical_name_id; RETURN NEW;
      END IF;
      RAISE EXCEPTION 'published project names belong to their node volume' USING ERRCODE='23514';
    END IF;
    IF (OLD.name::text IS DISTINCT FROM NEW.name::text OR OLD.logical_name_revision IS DISTINCT FROM NEW.logical_name_revision) THEN
      NEW.logical_name_revision=OLD.logical_name_revision+1;
      NEW.logical_name_id=gen_random_uuid();
      UPDATE harness.project_content_copy_jobs SET source_revision=source_revision+1 WHERE organization_id=OLD.organization_id AND project_id=OLD.id AND NOT published;
    ELSE NEW.logical_name_id=OLD.logical_name_id; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fence_project_names BEFORE INSERT OR UPDATE OF name,logical_name_revision,logical_name_id,status ON harness.projects
  FOR EACH ROW EXECUTE FUNCTION harness.fence_project_names();
CREATE FUNCTION harness.require_project_name_claims() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE policy harness.project_name_policies%ROWTYPE; current_revision bigint;
BEGIN
  SELECT * INTO policy FROM harness.project_name_policies WHERE organization_id=NEW.organization_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT logical_name_revision INTO current_revision FROM harness.projects WHERE id=NEW.id AND organization_id=NEW.organization_id AND status='active';
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF policy.normalization IS DISTINCT FROM harness.project_name_normalization() OR EXISTS(
    SELECT FROM unnest(array_remove(ARRAY[policy.active_key,policy.next_key],NULL)) k WHERE NOT EXISTS (
      SELECT FROM harness.project_name_claims c WHERE c.organization_id=NEW.organization_id AND c.project_id=NEW.id AND c.key_id=k AND c.name_revision=current_revision)
  ) THEN RAISE EXCEPTION 'current organization project name proof is required' USING ERRCODE='23514',CONSTRAINT='project_name_policy_coverage'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER require_project_name_claims AFTER INSERT OR UPDATE OF name,logical_name_revision,status ON harness.projects
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION harness.require_project_name_claims();
CREATE FUNCTION harness.fence_project_mount_content() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT FROM harness.project_content_placement b WHERE b.organization_id=NEW.organization_id AND b.project_id=NEW.project_id)
    AND (NEW.local_path<>'urn:hgw:project:'||NEW.project_id::text OR NEW.canonical_path<>'urn:hgw:project:'||NEW.project_id::text) THEN
    RAISE EXCEPTION 'published workspace paths belong to their node volume' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (OLD.local_path,OLD.canonical_path) IS DISTINCT FROM (NEW.local_path,NEW.canonical_path) THEN
    UPDATE harness.project_content_copy_jobs SET source_revision=source_revision+1 WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id AND NOT published;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fence_project_mount_content BEFORE INSERT OR UPDATE OF project_id,node_id,local_path,canonical_path ON harness.project_mounts
  FOR EACH ROW EXECUTE FUNCTION harness.fence_project_mount_content();
