-- Source and destination receipts carry only opaque scope, process, content and delivery identifiers. File paths and prompts remain on the nodes.
CREATE TABLE harness.project_recovery_operations (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, runtime_id uuid NOT NULL, policy_id uuid NOT NULL,
  point_id uuid NOT NULL REFERENCES harness.peer_backup_points(id) DEFERRABLE INITIALLY DEFERRED, policy_revision integer NOT NULL, approved_by uuid NOT NULL,
  source_node_id uuid NOT NULL, source_volume_id uuid NOT NULL, source_epoch bigint NOT NULL CHECK(source_epoch>0),
  target_node_id uuid NOT NULL, target_volume_id uuid NOT NULL, target_epoch bigint NOT NULL CHECK(target_epoch=source_epoch+1),
  manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'), point_revision bigint NOT NULL CHECK(point_revision>=0),
  phase text NOT NULL CHECK(phase IN ('prepared','target-ready','retire-approved','retiring','old-fenced','switching','published','cancelled')),
  retirement_approved_by uuid, retirement_approved_at timestamptz, retry_at timestamptz NOT NULL DEFAULT now(), last_error text,
  target_port_base integer CHECK(target_port_base BETWEEN 1024 AND 65535),
  target_files_digest text CHECK(target_files_digest ~ '^[a-f0-9]{64}$'),source_files_digest text CHECK(source_files_digest ~ '^[a-f0-9]{64}$'),
  target_verified_at timestamptz, target_schedule_digest text CHECK(target_schedule_digest ~ '^[a-f0-9]{64}$'),
  old_fenced_at timestamptz, stopped_generation bigint CHECK(stopped_generation>0), stop_operation_id uuid,
  target_activated_at timestamptz, source_schedule_digest text CHECK(source_schedule_digest ~ '^[a-f0-9]{64}$'), published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(source_node_id<>target_node_id AND source_volume_id<>target_volume_id),
  FOREIGN KEY(policy_id,organization_id) REFERENCES harness.peer_backup_policies(id,organization_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(project_id,organization_id) REFERENCES harness.projects(id,organization_id),
  FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
  FOREIGN KEY(retirement_approved_by,organization_id) REFERENCES harness.users(id,organization_id),
  FOREIGN KEY(approved_by,organization_id) REFERENCES harness.users(id,organization_id),
  FOREIGN KEY(organization_id,source_node_id,source_volume_id) REFERENCES harness.node_content_volumes(organization_id,node_id,volume_id),
  FOREIGN KEY(organization_id,target_node_id,target_volume_id) REFERENCES harness.node_content_volumes(organization_id,node_id,volume_id)
);
CREATE UNIQUE INDEX one_project_takeover ON harness.project_recovery_operations(organization_id,project_id)
  WHERE phase NOT IN ('cancelled','published');
CREATE FUNCTION harness.project_recovery_owner(org uuid,project uuid,runtime uuid,old_node uuid,old_volume uuid,old_epoch bigint,
  next_node uuid,next_volume uuid,next_epoch bigint) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT FROM harness.project_recovery_operations r WHERE r.id::text=current_setting('hgw.recovery_operation',true)
    AND (r.organization_id,r.project_id,r.runtime_id,r.source_node_id,r.source_volume_id,r.source_epoch,
      r.target_node_id,r.target_volume_id,r.target_epoch)=(org,project,runtime,old_node,old_volume,old_epoch,next_node,next_volume,next_epoch)
    AND r.phase='switching' AND r.target_verified_at IS NOT NULL AND r.old_fenced_at IS NOT NULL AND r.stopped_generation>0
    AND r.stop_operation_id IS NOT NULL AND r.source_files_digest=r.target_files_digest AND r.source_schedule_digest=r.target_schedule_digest)
$$;
CREATE FUNCTION harness.block_retiring_project_runtime() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT FROM harness.project_recovery_operations r WHERE r.organization_id=NEW.organization_id AND r.runtime_id=NEW.runtime_id
    AND r.phase IN ('retiring','old-fenced','switching')) AND
    (NEW.runtime_token_hash IS NOT NULL OR NEW.desired_state<>'stopped' OR NEW.observed_state NOT IN ('stopped','stopping') OR NEW.generation<>OLD.generation)
    THEN RAISE EXCEPTION 'Project recovery holds the stopped Runtime generation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_recovery_runtime BEFORE UPDATE OF generation,desired_state,observed_state,runtime_token_hash
  ON harness.instances FOR EACH ROW EXECUTE FUNCTION harness.block_retiring_project_runtime();
CREATE OR REPLACE FUNCTION harness.check_project_content_placement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'a published content placement cannot revert to shared storage' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM harness.runtime_environments r WHERE r.id=NEW.runtime_id
    AND r.organization_id=NEW.organization_id AND r.owner_kind='project' AND r.owner_id=NEW.project_id
    AND r.node_id=NEW.node_id AND r.retired_at IS NULL) THEN
    RAISE EXCEPTION 'content placement disagrees with the Runtime owner or computer' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (OLD.organization_id,OLD.project_id,OLD.runtime_id,OLD.node_id,OLD.volume_id,OLD.writer_epoch)
     IS DISTINCT FROM (NEW.organization_id,NEW.project_id,NEW.runtime_id,NEW.node_id,NEW.volume_id,NEW.writer_epoch)
    AND NOT ((OLD.organization_id,OLD.project_id,OLD.runtime_id)=(NEW.organization_id,NEW.project_id,NEW.runtime_id)
      AND harness.project_recovery_owner(OLD.organization_id,OLD.project_id,OLD.runtime_id,OLD.node_id,OLD.volume_id,OLD.writer_epoch,
        NEW.node_id,NEW.volume_id,NEW.writer_epoch)) THEN
    RAISE EXCEPTION 'active content placement requires a fenced transition' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.source_retirement<>NEW.source_retirement
    AND NOT (OLD.source_retirement='retiring' AND NEW.source_retirement='retired') THEN
    RAISE EXCEPTION 'invalid source retirement transition';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION harness.retain_published_content_owner() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT FROM harness.project_content_placement b WHERE
    (b.runtime_id=NEW.id OR (NEW.owner_kind='project' AND b.organization_id=NEW.organization_id AND b.project_id=NEW.owner_id))
    AND (b.runtime_id,b.organization_id,b.project_id,b.node_id,'project') IS DISTINCT FROM
      (NEW.id,NEW.organization_id,NEW.owner_id,NEW.node_id,NEW.owner_kind) AND NOT EXISTS(
        SELECT FROM harness.project_recovery_operations r WHERE r.id::text=current_setting('hgw.recovery_operation',true)
          AND (b.organization_id,b.project_id,b.runtime_id,b.node_id,b.volume_id,b.writer_epoch)=
            (r.organization_id,r.project_id,r.runtime_id,r.source_node_id,r.source_volume_id,r.source_epoch)
          AND (NEW.id,NEW.organization_id,NEW.owner_id,NEW.node_id,NEW.owner_kind)=(r.runtime_id,r.organization_id,r.project_id,r.target_node_id,'project')
          AND harness.project_recovery_owner(r.organization_id,r.project_id,r.runtime_id,r.source_node_id,r.source_volume_id,r.source_epoch,
            r.target_node_id,r.target_volume_id,r.target_epoch))) THEN
    RAISE EXCEPTION 'a published project requires its recorded Runtime and node' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION harness.check_document_scope_placement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.scope_kind='project' AND
    (OLD.organization_id,OLD.scope_kind,OLD.scope_id,OLD.root_id,OLD.project_runtime_id)=(NEW.organization_id,NEW.scope_kind,NEW.scope_id,NEW.root_id,NEW.project_runtime_id)
    AND harness.project_recovery_owner(OLD.organization_id,OLD.scope_id,OLD.project_runtime_id,OLD.node_id,OLD.volume_id,OLD.writer_epoch,
      NEW.node_id,NEW.volume_id,NEW.writer_epoch) THEN RETURN NEW; END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Document scope publication is immutable'; END IF;
  IF NEW.scope_kind='personal' AND NOT EXISTS(SELECT FROM harness.users u WHERE u.organization_id=NEW.organization_id AND u.id=NEW.scope_id)
    OR NEW.scope_kind='project' AND NOT EXISTS(SELECT FROM harness.runtime_environments r
       WHERE r.organization_id=NEW.organization_id AND r.node_id=NEW.node_id AND r.owner_kind='project'
         AND r.owner_id=NEW.scope_id AND r.id=NEW.project_runtime_id AND r.retired_at IS NULL)
  THEN RAISE EXCEPTION 'Document scope owner does not match its assigned node'; END IF;
  IF EXISTS(SELECT FROM harness.document_catalog d WHERE d.organization_id=NEW.organization_id AND d.node_id=NEW.node_id
      AND d.scope_kind=NEW.scope_kind AND coalesce(d.scope_user_id,d.scope_project_id)=NEW.scope_id)
    OR EXISTS(SELECT FROM harness.document_projection_checkpoints c WHERE c.organization_id=NEW.organization_id AND c.node_id=NEW.node_id
      AND c.scope_kind=NEW.scope_kind AND coalesce(c.scope_user_id,c.scope_project_id)=NEW.scope_id)
    OR EXISTS(SELECT FROM harness.document_operations e WHERE e.organization_id=NEW.organization_id AND
      ((NEW.scope_kind='project' AND NEW.scope_id IN (e.source_project_id,e.target_project_id)) OR
       (NEW.scope_kind='personal' AND NEW.scope_id IN (e.source_user_id,e.target_user_id))))
  THEN RAISE EXCEPTION 'Document scope still has shared catalog or transfer history'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION harness.keep_project_recovery_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Project recovery history is immutable'; END IF;
  IF (to_jsonb(NEW)-'target_activated_at'-'last_error')=(to_jsonb(OLD)-'target_activated_at'-'last_error') AND OLD.phase='published'
    AND OLD.target_activated_at IS NULL AND NEW.target_activated_at IS NOT NULL THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW)-ARRAY['retry_at','last_error'])=(to_jsonb(OLD)-ARRAY['retry_at','last_error']) THEN RETURN NEW; END IF;
  IF OLD.retirement_approved_at IS NOT NULL AND (NEW.retirement_approved_by,NEW.retirement_approved_at) IS DISTINCT FROM
    (OLD.retirement_approved_by,OLD.retirement_approved_at) THEN RAISE EXCEPTION 'Recovery retirement approval is immutable'; END IF;
  IF (to_jsonb(NEW)-ARRAY['retirement_approved_by','retirement_approved_at','last_error','retry_at','target_port_base','target_files_digest','source_files_digest','phase','target_verified_at','target_schedule_digest','old_fenced_at','stopped_generation','stop_operation_id',
      'source_schedule_digest','published_at'])<>(to_jsonb(OLD)-ARRAY['retirement_approved_by','retirement_approved_at','last_error','retry_at','target_port_base','target_files_digest','source_files_digest','phase','target_verified_at','target_schedule_digest','old_fenced_at',
      'stopped_generation','stop_operation_id','source_schedule_digest','published_at']) OR
    OLD.target_verified_at IS NOT NULL AND (NEW.target_verified_at,NEW.target_schedule_digest,NEW.target_files_digest,NEW.target_port_base) IS DISTINCT FROM (OLD.target_verified_at,OLD.target_schedule_digest,OLD.target_files_digest,OLD.target_port_base)
    OR OLD.old_fenced_at IS NOT NULL AND (NEW.old_fenced_at,NEW.stopped_generation,NEW.stop_operation_id,NEW.source_schedule_digest,NEW.source_files_digest)
       IS DISTINCT FROM (OLD.old_fenced_at,OLD.stopped_generation,OLD.stop_operation_id,OLD.source_schedule_digest,OLD.source_files_digest)
    OR NOT ((OLD.phase,NEW.phase) IN (('prepared','target-ready'),('prepared','cancelled'),('target-ready','cancelled'),
      ('target-ready','retire-approved'),('retire-approved','retiring'),('retire-approved','cancelled'),('retiring','old-fenced'),('old-fenced','switching'),('switching','published')))
    THEN RAISE EXCEPTION 'Invalid project recovery transition'; END IF;
  IF NEW.phase='retire-approved' AND (NEW.retirement_approved_at IS NULL OR NEW.retirement_approved_by IS NULL)
    OR NEW.phase='target-ready' AND (NEW.target_verified_at IS NULL OR NEW.target_schedule_digest IS NULL OR NEW.target_files_digest IS NULL OR NEW.target_port_base IS NULL)
    OR NEW.phase='old-fenced' AND (NEW.old_fenced_at IS NULL OR NEW.stopped_generation IS NULL OR NEW.stop_operation_id IS NULL
      OR NEW.source_schedule_digest IS DISTINCT FROM NEW.target_schedule_digest OR NEW.source_files_digest IS DISTINCT FROM NEW.target_files_digest)
    OR NEW.phase='published' AND NEW.published_at IS NULL THEN RAISE EXCEPTION 'Incomplete project recovery evidence'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER keep_project_recovery_evidence BEFORE UPDATE OR DELETE ON harness.project_recovery_operations FOR EACH ROW EXECUTE FUNCTION harness.keep_project_recovery_evidence();
