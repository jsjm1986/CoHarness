-- Existing plaintext sources can survive logical deletion in cluster media, WAL, projections and retained copies.
CREATE FUNCTION harness.retirement_source_cluster() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT system_identifier::text FROM pg_control_system();
$$;
ALTER TABLE harness.project_content_copy_jobs ADD COLUMN source_cluster_id text;
ALTER TABLE harness.project_content_copy_jobs ADD COLUMN source_database_oid oid;
ALTER TABLE harness.project_content_copy_jobs ALTER COLUMN source_cluster_id SET DEFAULT harness.retirement_source_cluster();
CREATE FUNCTION harness.retirement_source_database() RETURNS oid LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT oid FROM pg_database WHERE datname=current_database();
$$;
ALTER TABLE harness.project_content_copy_jobs ALTER COLUMN source_database_oid SET DEFAULT harness.retirement_source_database();
CREATE FUNCTION harness.freeze_retirement_source() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN NEW.source_cluster_id=harness.retirement_source_cluster(); NEW.source_database_oid=harness.retirement_source_database();
  ELSIF (NEW.source_cluster_id,NEW.source_database_oid) IS DISTINCT FROM (OLD.source_cluster_id,OLD.source_database_oid) THEN
    RAISE EXCEPTION 'The original cluster identity cannot be reassigned';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER freeze_retirement_source BEFORE INSERT OR UPDATE OF source_cluster_id,source_database_oid ON harness.project_content_copy_jobs
  FOR EACH ROW EXECUTE FUNCTION harness.freeze_retirement_source();
CREATE FUNCTION harness.retirement_backup_inventory(org uuid) RETURNS bytea LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT sha256(convert_to(COALESCE(string_agg(item,E'\n' ORDER BY item COLLATE "C"),''),'UTF8')) FROM (
    SELECT jsonb_build_array('database',b.id,b.sha256,b.migration_version,b.write_epoch,b.size_bytes,b.status,
      extract(epoch FROM b.created_at)::text,extract(epoch FROM b.verified_at)::text) ::text item FROM harness.backup_records b WHERE b.organization_id=org
    UNION ALL SELECT jsonb_build_array('governance-point',p.id,p.policy_id,p.revision,p.snapshot_id,p.manifest_digest,p.writer_epoch,p.watermark)::text
      FROM harness.peer_backup_points p JOIN harness.peer_backup_policies c ON c.id=p.policy_id AND c.organization_id=p.organization_id
      WHERE p.organization_id=org AND c.scope_kind='governance'
  ) inventory;
$$;
CREATE TABLE harness.project_source_retirement_reviews(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,project_id uuid NOT NULL,runtime_id uuid NOT NULL,node_id uuid NOT NULL,
  volume_id uuid NOT NULL,writer_epoch bigint NOT NULL,job_id uuid NOT NULL REFERENCES harness.project_content_copy_jobs(id),
  source_revision bigint NOT NULL,source_cluster_id text NOT NULL,source_database_oid oid NOT NULL,node_snapshot_id uuid NOT NULL,
  backup_inventory_digest bytea NOT NULL CHECK(octet_length(backup_inventory_digest)=32),
  requested_by uuid NOT NULL,policy_digest bytea NOT NULL CHECK(octet_length(policy_digest)=32),owner_coverage_digest bytea NOT NULL CHECK(octet_length(owner_coverage_digest)=32),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(organization_id,project_id,runtime_id,node_id,volume_id,writer_epoch,job_id,source_revision,policy_digest,backup_inventory_digest),
  FOREIGN KEY(organization_id,project_id) REFERENCES harness.project_content_placement(organization_id,project_id),
  FOREIGN KEY(requested_by,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE TABLE harness.project_source_retirement_evidence(
  review_id uuid NOT NULL REFERENCES harness.project_source_retirement_reviews(id),domain text NOT NULL
    CHECK(domain IN ('policy','wal','backups','replicas','cluster-media','other-projections')),
  inventory_digest bytea NOT NULL CHECK(octet_length(inventory_digest)=32),proof_digest bytea NOT NULL CHECK(octet_length(proof_digest)=32),
  signer_fingerprint bytea NOT NULL CHECK(octet_length(signer_fingerprint)=32),verified_at timestamptz NOT NULL,
  observed_resources bigint NOT NULL CHECK(observed_resources>=0),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by name NOT NULL,PRIMARY KEY(review_id,domain)
);
CREATE FUNCTION harness.require_retirement_witness() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE required_login text; opened timestamptz;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Source-retirement evidence is immutable'; END IF;
  required_login='hgw_retire_'||replace(NEW.domain,'-','_');
  IF SESSION_USER::text<>required_login THEN RAISE EXCEPTION 'A separate source-custodian login must record this evidence' USING ERRCODE='42501'; END IF;
  SELECT opened_at INTO STRICT opened FROM harness.project_source_retirement_reviews WHERE id=NEW.review_id;
  IF NEW.verified_at<opened OR NEW.verified_at>clock_timestamp() THEN RAISE EXCEPTION 'Evidence predates the review or comes from the future'; END IF;
  NEW.recorded_by=SESSION_USER; NEW.recorded_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER require_retirement_witness BEFORE INSERT OR UPDATE OR DELETE ON harness.project_source_retirement_evidence
  FOR EACH ROW EXECUTE FUNCTION harness.require_retirement_witness();
CREATE FUNCTION harness.require_retirement_review() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Source-retirement reviews are immutable'; END IF;
  IF NOT EXISTS(SELECT FROM harness.project_content_copy_jobs j JOIN harness.project_content_placement p
    ON (p.organization_id,p.project_id,p.runtime_id)=(j.organization_id,j.project_id,j.runtime_id)
    JOIN harness.organizations o ON o.id=p.organization_id AND o.status='active'
    JOIN harness.memberships m ON m.organization_id=o.id AND m.user_id=NEW.requested_by AND m.role='admin' AND m.status='active'
    JOIN harness.users u ON u.organization_id=o.id AND u.id=m.user_id AND u.status='active' AND u.deleted_at IS NULL
    WHERE (p.organization_id,p.project_id,p.runtime_id,p.node_id,p.volume_id,p.writer_epoch)=
      (NEW.organization_id,NEW.project_id,NEW.runtime_id,NEW.node_id,NEW.volume_id,NEW.writer_epoch)
      AND p.source_retirement='retiring' AND j.id=NEW.job_id AND j.source_revision=NEW.source_revision AND j.published
      AND j.source_cluster_id=NEW.source_cluster_id AND j.source_database_oid=NEW.source_database_oid) THEN
    RAISE EXCEPTION 'Source-retirement review requires the current published allocation and original cluster identity';
  END IF;
  IF NEW.backup_inventory_digest<>harness.retirement_backup_inventory(NEW.organization_id) THEN RAISE EXCEPTION 'The source backup inventory changed'; END IF;
  NEW.opened_at=clock_timestamp(); RETURN NEW;
END $$;
CREATE TRIGGER require_retirement_review BEFORE INSERT OR UPDATE OR DELETE ON harness.project_source_retirement_reviews
  FOR EACH ROW EXECUTE FUNCTION harness.require_retirement_review();

-- A known-source scan reports only relation names; row bodies, filenames and search terms never become receipts.
CREATE FUNCTION harness.retained_project_payload(org uuid,project uuid,allocation uuid) RETURNS SETOF text LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE t text;present boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversation_sessions','conversation_events','conversation_search','conversation_append_batches',
    'conversation_draft_reservations','conversation_participants','conversation_interaction_responses','conversation_migrations','conversation_migrated_events',
    'execution_sessions','execution_inputs','execution_relays','execution_scopes','desktop_session_confirmations','plugin_states',
    'conversation_archive_records','conversation_archive_search','content_files','runtime_workspace_catalog'] LOOP
    EXECUTE format('SELECT EXISTS(SELECT FROM harness.%I WHERE organization_id=$1 AND runtime_id=$2)',t) INTO present USING org,allocation;
    IF present THEN RETURN NEXT t; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['project_journal','project_journal_state','project_journal_materials','project_journal_requests'] LOOP
    EXECUTE format('SELECT EXISTS(SELECT FROM harness.%I WHERE organization_id=$1 AND project_id=$2)',t) INTO present USING org,project;
    IF present THEN RETURN NEXT t; END IF;
  END LOOP;
  IF EXISTS(SELECT FROM harness.content_files WHERE organization_id=org AND project_id=project) THEN RETURN NEXT 'project_file_references'; END IF;
  IF EXISTS(SELECT FROM harness.conversation_archive_records a JOIN harness.projects p ON p.organization_id=org AND p.id=project
    WHERE a.organization_id=org AND a.runtime_kind='project' AND (a.project_id=project OR a.runtime_public_id=p.public_id)) THEN RETURN NEXT 'historical_archive'; END IF;
  IF EXISTS(SELECT FROM harness.document_catalog WHERE organization_id=org AND scope_project_id=project) THEN RETURN NEXT 'document_catalog'; END IF;
  IF EXISTS(SELECT FROM harness.document_operations WHERE organization_id=org AND (source_project_id=project OR target_project_id=project)) THEN RETURN NEXT 'document_operations'; END IF;
  IF EXISTS(SELECT FROM harness.document_projection_checkpoints WHERE organization_id=org AND scope_project_id=project) THEN RETURN NEXT 'document_checkpoints'; END IF;
  IF EXISTS(SELECT FROM harness.projects WHERE id=project AND organization_id=org AND name::text<>'hgw-project-'||project::text)
    OR EXISTS(SELECT FROM harness.project_mounts WHERE project_id=project AND organization_id=org AND (local_path<>'urn:hgw:project:'||project::text OR canonical_path<>'urn:hgw:project:'||project::text)) THEN RETURN NEXT 'project_display'; END IF;
END $$;
CREATE FUNCTION harness.attest_source_retired() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE review uuid;
BEGIN
  IF TG_OP='INSERT' AND NEW.source_retirement='retired' THEN RAISE EXCEPTION 'A new placement has no verified source retirement'; END IF;
  IF TG_OP='UPDATE' AND NEW.source_retirement='retired' AND OLD.source_retirement<>'retired' THEN
    SELECT r.id INTO review FROM harness.project_source_retirement_reviews r JOIN harness.project_content_copy_jobs j ON j.id=r.job_id
      WHERE (r.organization_id,r.project_id,r.runtime_id,r.node_id,r.volume_id,r.writer_epoch)=
        (NEW.organization_id,NEW.project_id,NEW.runtime_id,NEW.node_id,NEW.volume_id,NEW.writer_epoch)
        AND r.id::text=current_setting('hgw.source_retirement_review',true) AND j.published AND j.source_revision=r.source_revision
        AND j.source_cluster_id=r.source_cluster_id AND j.source_database_oid=r.source_database_oid
        AND r.source_cluster_id<>harness.retirement_source_cluster() AND r.backup_inventory_digest=harness.retirement_backup_inventory(NEW.organization_id)
        AND NOT EXISTS(SELECT FROM unnest(ARRAY['policy','wal','backups','replicas','cluster-media','other-projections']) d
          WHERE NOT EXISTS(SELECT FROM harness.project_source_retirement_evidence e WHERE e.review_id=r.id AND e.domain=d));
    IF review IS NULL OR EXISTS(SELECT FROM harness.retained_project_payload(NEW.organization_id,NEW.project_id,NEW.runtime_id))
      OR EXISTS(SELECT FROM harness.ambiguous_project_payload(NEW.organization_id,NEW.project_id,NEW.runtime_id)) THEN
      RAISE EXCEPTION 'The original database, retention obligations or physical media lack verified project retirement' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attest_source_retired BEFORE INSERT OR UPDATE OF source_retirement ON harness.project_content_placement
  FOR EACH ROW EXECUTE FUNCTION harness.attest_source_retired();

-- Pre-namespace records can have a project/public owner but no compatible Runtime. Keep these visible to migration and retirement.
CREATE FUNCTION harness.ambiguous_project_payload(org uuid,project uuid,allocation uuid) RETURNS SETOF text LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE t text;parts text[];present boolean;public_project bigint;cols text[];
BEGIN
  SELECT public_id INTO STRICT public_project FROM harness.projects WHERE id=project AND organization_id=org;
  FOREACH t IN ARRAY ARRAY['conversation_sessions','conversation_events','conversation_search','conversation_append_batches','conversation_participants',
    'conversation_interaction_responses','conversation_draft_reservations','conversation_migrations','conversation_migrated_events','execution_sessions','execution_inputs',
    'execution_scopes','execution_relays','desktop_session_confirmations','content_files','plugin_states','conversation_archive_records','conversation_archive_search'] LOOP
    SELECT array_agg(attname::text) INTO cols FROM pg_attribute WHERE attrelid=format('harness.%I',t)::regclass AND attnum>0 AND NOT attisdropped;
    parts=ARRAY[]::text[];
    IF 'project_id'=ANY(cols) THEN parts=array_append(parts,'r.project_id=$2'); END IF;
    IF ARRAY['runtime_kind','runtime_public_id']::text[] <@ cols THEN parts=array_append(parts,'(r.runtime_kind=''project'' AND r.runtime_public_id=$4)'); END IF;
    IF 'session_id'=ANY(cols) THEN parts=array_append(parts,'(r.runtime_id IS NULL AND EXISTS(SELECT FROM harness.conversation_sessions s WHERE s.organization_id=$1 AND s.runtime_id=$3 AND s.project_id=$2 AND s.id=r.session_id))'); END IF;
    IF cardinality(parts)>0 THEN
      EXECUTE format('SELECT EXISTS(SELECT FROM harness.%I r WHERE r.organization_id=$1 AND r.runtime_id IS DISTINCT FROM $3 AND (%s))',t,array_to_string(parts,' OR '))
        INTO present USING org,project,allocation,public_project;
      IF present THEN RETURN NEXT t; END IF;
    END IF;
  END LOOP;
END $$;
CREATE FUNCTION harness.require_retirement_origin() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.source_retirement='new' AND NOT EXISTS(SELECT FROM harness.projects p WHERE p.id=NEW.project_id AND p.organization_id=NEW.organization_id AND p.content_creation_xid=pg_current_xact_id()) THEN
    RAISE EXCEPTION 'Only a newly allocated project can have no predecessor';
  ELSIF NEW.source_retirement='retiring' AND NOT EXISTS(SELECT FROM harness.project_content_copy_jobs j WHERE j.organization_id=NEW.organization_id
    AND j.project_id=NEW.project_id AND j.runtime_id=NEW.runtime_id AND j.node_id=NEW.node_id AND j.volume_id=NEW.volume_id AND j.published AND j.publication_xid=pg_current_xact_id()) THEN
    RAISE EXCEPTION 'A retained predecessor requires a verified migration';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER require_retirement_origin AFTER INSERT ON harness.project_content_placement DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION harness.require_retirement_origin();
