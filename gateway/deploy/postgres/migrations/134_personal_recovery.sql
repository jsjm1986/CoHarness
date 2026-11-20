-- Personal disaster replacement retains account/Runtime identities and account-shared document ownership.
CREATE TABLE harness.personal_recovery_operations (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,user_id uuid NOT NULL,runtime_id uuid NOT NULL,
 policy_id uuid NOT NULL,policy_revision integer NOT NULL,point_id uuid NOT NULL,
 approved_by uuid NOT NULL,source_node_id uuid NOT NULL,source_generation bigint NOT NULL CHECK(source_generation>0),
 source_epoch bigint NOT NULL CHECK(source_epoch>0 AND source_epoch<=source_generation),
 target_node_id uuid NOT NULL,target_epoch bigint NOT NULL CHECK(target_epoch=source_generation+1),
 source_document_root uuid NOT NULL,source_volume_id uuid NOT NULL,source_document_epoch bigint NOT NULL CHECK(source_document_epoch>0),
 target_volume_id uuid NOT NULL,target_document_epoch bigint NOT NULL CHECK(target_document_epoch=source_document_epoch+1),
 manifest_digest text NOT NULL CHECK(manifest_digest~'^[a-f0-9]{64}$'),point_revision bigint NOT NULL CHECK(point_revision>=0),
 phase text NOT NULL DEFAULT 'preparing' CHECK(phase IN('preparing','prepared','externally-fenced','activating','switching','published','cancelled')),
 target_files_digest text CHECK(target_files_digest~'^[a-f0-9]{64}$'),target_evidence_digest text CHECK(target_evidence_digest~'^[a-f0-9]{64}$'),
 target_document_digest text CHECK(target_document_digest~'^[a-f0-9]{64}$'),document_receipt_operation_id uuid,
 target_verified_at timestamptz,target_activated_at timestamptz,activation_approved_by uuid,activation_approved_at timestamptz,
 suspended_environment_keys jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(suspended_environment_keys)='array' AND jsonb_array_length(suspended_environment_keys)<=128),
 old_session_count bigint CHECK(old_session_count>=0),retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),published_at timestamptz,
 CHECK(source_node_id<>target_node_id),
 FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
 FOREIGN KEY(user_id,organization_id) REFERENCES harness.users(id,organization_id),
 FOREIGN KEY(approved_by,organization_id) REFERENCES harness.users(id,organization_id),
 FOREIGN KEY(activation_approved_by,organization_id) REFERENCES harness.users(id,organization_id),
 FOREIGN KEY(policy_id,organization_id) REFERENCES harness.peer_backup_policies(id,organization_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(point_id) REFERENCES harness.peer_backup_points(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(organization_id,source_node_id,source_volume_id) REFERENCES harness.node_content_volumes(organization_id,node_id,volume_id),
 FOREIGN KEY(organization_id,target_node_id,target_volume_id) REFERENCES harness.node_content_volumes(organization_id,node_id,volume_id)
);
CREATE UNIQUE INDEX personal_recovery_active ON harness.personal_recovery_operations(organization_id,runtime_id)
 WHERE phase NOT IN('published','cancelled');
CREATE UNIQUE INDEX personal_recovery_account_active ON harness.personal_recovery_operations(organization_id,user_id,source_node_id,target_node_id)
 WHERE phase NOT IN('published','cancelled');
CREATE TABLE harness.personal_recovery_policy_approvals (
 id uuid PRIMARY KEY,operation_id uuid NOT NULL REFERENCES harness.personal_recovery_operations(id),organization_id uuid NOT NULL,
 policy_revision integer NOT NULL,phase text NOT NULL,approved_by uuid NOT NULL,approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(operation_id,policy_revision),FOREIGN KEY(approved_by,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE TRIGGER immutable_personal_recovery_policy BEFORE UPDATE OR DELETE ON harness.personal_recovery_policy_approvals
 FOR EACH ROW EXECUTE FUNCTION harness.preserve_disaster_receipt();
CREATE FUNCTION harness.personal_recovery_policy_revision(operation uuid,original integer) RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT policy_revision FROM harness.personal_recovery_policy_approvals WHERE operation_id=operation ORDER BY policy_revision DESC LIMIT 1),original)
$$;
CREATE TABLE harness.personal_recovery_execution_holds (
 operation_id uuid PRIMARY KEY REFERENCES harness.personal_recovery_operations(id),organization_id uuid NOT NULL,runtime_id uuid NOT NULL,
 FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id)
);
CREATE TRIGGER immutable_personal_recovery_hold BEFORE UPDATE OR DELETE ON harness.personal_recovery_execution_holds
 FOR EACH ROW EXECUTE FUNCTION harness.preserve_disaster_receipt();
CREATE TABLE harness.personal_recovery_document_receipts (
 operation_id uuid PRIMARY KEY REFERENCES harness.personal_recovery_operations(id),organization_id uuid NOT NULL,user_id uuid NOT NULL,
 source_node_id uuid NOT NULL,root_id uuid NOT NULL,source_volume_id uuid NOT NULL,source_epoch bigint NOT NULL,
 target_node_id uuid NOT NULL,target_volume_id uuid NOT NULL,target_epoch bigint NOT NULL,
 document_digest text NOT NULL CHECK(document_digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(organization_id,source_node_id,user_id,root_id),
 FOREIGN KEY(user_id,organization_id) REFERENCES harness.users(id,organization_id)
);
ALTER TABLE harness.personal_recovery_operations ADD FOREIGN KEY(document_receipt_operation_id) REFERENCES harness.personal_recovery_document_receipts(operation_id);
CREATE TRIGGER immutable_personal_recovery_documents BEFORE UPDATE OR DELETE ON harness.personal_recovery_document_receipts
 FOR EACH ROW EXECUTE FUNCTION harness.preserve_disaster_receipt();
CREATE TABLE harness.personal_recovery_execution_requests (
 operation_id uuid PRIMARY KEY REFERENCES harness.personal_recovery_execution_holds(operation_id),organization_id uuid NOT NULL,
 request_id uuid NOT NULL,requested_by uuid NOT NULL,requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 status text NOT NULL CHECK(status IN('queued','ready','failed')),review_id uuid,error_code text,
 FOREIGN KEY(requested_by,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE TABLE harness.personal_recovery_execution_reviews (
 LIKE harness.project_recovery_execution_reviews INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 PRIMARY KEY(id),FOREIGN KEY(operation_id) REFERENCES harness.personal_recovery_execution_holds(operation_id),
 FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
 FOREIGN KEY(organization_id,target_node_id) REFERENCES harness.compute_nodes(organization_id,id)
);
ALTER TABLE harness.personal_recovery_execution_requests ADD FOREIGN KEY(review_id) REFERENCES harness.personal_recovery_execution_reviews(id);
CREATE TABLE harness.personal_recovery_execution_approvals (
 LIKE harness.project_recovery_execution_approvals INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 PRIMARY KEY(review_id),FOREIGN KEY(review_id) REFERENCES harness.personal_recovery_execution_reviews(id),
 FOREIGN KEY(approved_by,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE TABLE harness.personal_recovery_execution_item_approvals (
 LIKE harness.project_recovery_execution_item_approvals INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 PRIMARY KEY(review_id,item_digest),FOREIGN KEY(review_id) REFERENCES harness.personal_recovery_execution_reviews(id),
 FOREIGN KEY(approved_by,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE TRIGGER immutable_personal_execution_review BEFORE UPDATE OR DELETE ON harness.personal_recovery_execution_reviews
 FOR EACH ROW EXECUTE FUNCTION harness.preserve_disaster_receipt();
CREATE TRIGGER immutable_personal_execution_approval BEFORE UPDATE OR DELETE ON harness.personal_recovery_execution_approvals
 FOR EACH ROW EXECUTE FUNCTION harness.preserve_disaster_receipt();
CREATE TRIGGER immutable_personal_execution_item BEFORE UPDATE OR DELETE ON harness.personal_recovery_execution_item_approvals
 FOR EACH ROW EXECUTE FUNCTION harness.preserve_disaster_receipt();
CREATE INDEX personal_recovery_execution_queued ON harness.personal_recovery_execution_requests(requested_at) WHERE status='queued';
CREATE INDEX personal_recovery_execution_files ON harness.personal_recovery_execution_reviews(organization_id,target_node_id,runtime_id);

CREATE FUNCTION harness.personal_recovery_owner(org uuid,runtime uuid,owner uuid,old_node uuid,next_node uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT FROM harness.personal_recovery_operations r JOIN harness.recovery_source_isolations isolation ON isolation.operation_id=r.id
   JOIN harness.personal_recovery_execution_holds hold ON hold.operation_id=r.id
   WHERE r.id::text=current_setting('hgw.personal_recovery_operation',true)
     AND (r.organization_id,r.runtime_id,r.user_id,r.source_node_id,r.target_node_id)=(org,runtime,owner,old_node,next_node)
     AND r.phase='switching' AND r.target_verified_at IS NOT NULL AND r.activation_approved_at IS NOT NULL
     AND (isolation.organization_id,isolation.scope_kind,isolation.scope_id,isolation.runtime_id,isolation.source_node_id,
       isolation.source_generation,isolation.source_epoch,isolation.point_id)=
       (r.organization_id,'personal',r.runtime_id,r.runtime_id,r.source_node_id,r.source_generation,r.source_epoch,r.point_id)
     AND harness.node_physically_isolated(org,old_node))
$$;
CREATE FUNCTION harness.personal_recovery_execution_allowed(org uuid,runtime uuid,node uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT FROM harness.personal_recovery_operations moving
   JOIN harness.runtime_environments e ON e.organization_id=moving.organization_id AND e.owner_kind='user' AND e.owner_id=moving.user_id
   WHERE moving.organization_id=org AND moving.target_node_id=node AND moving.phase IN('activating','switching') AND e.id=runtime)
 AND NOT EXISTS(SELECT FROM (SELECT h.operation_id FROM harness.personal_recovery_execution_holds h
   JOIN harness.personal_recovery_operations r ON r.id=h.operation_id WHERE h.organization_id=org AND h.runtime_id=runtime
   ORDER BY r.target_epoch DESC,r.created_at DESC LIMIT 1) held WHERE NOT EXISTS(
     SELECT FROM harness.personal_recovery_execution_requests request
     JOIN harness.personal_recovery_execution_reviews review ON review.id=request.review_id AND review.operation_id=request.operation_id
     JOIN harness.personal_recovery_execution_approvals approval ON approval.review_id=review.id AND approval.organization_id=org
     JOIN harness.personal_recovery_operations r ON r.id=review.operation_id
     JOIN harness.runtime_environments e ON e.id=r.runtime_id AND e.organization_id=r.organization_id
     JOIN harness.personal_directory_placement p ON p.runtime_id=e.id AND p.organization_id=e.organization_id AND p.owner_id=e.owner_id AND p.node_id=e.node_id
     WHERE request.operation_id=held.operation_id AND request.organization_id=org AND request.status='ready'
       AND r.organization_id=org AND r.phase='published' AND r.target_activated_at IS NOT NULL
       AND (review.runtime_id,review.target_node_id,review.target_epoch,review.point_id)=(runtime,node,r.target_epoch,r.point_id)
       AND review.organization_id=org AND review.blockers='[]'::jsonb
       AND e.owner_kind='user' AND e.owner_id=r.user_id AND e.node_id=node AND e.retired_at IS NULL))
$$;

CREATE FUNCTION harness.project_recovery_execution_allowed(org uuid,runtime uuid,node uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT FROM (SELECT hold.* FROM harness.project_recovery_execution_holds hold
   JOIN harness.project_recovery_operations prior ON prior.id=hold.operation_id
   WHERE hold.organization_id=org AND hold.runtime_id=runtime ORDER BY prior.target_epoch DESC,prior.created_at DESC LIMIT 1) h
   WHERE NOT EXISTS(SELECT FROM harness.project_recovery_execution_requests request
    JOIN harness.project_recovery_execution_reviews review ON review.id=request.review_id AND review.operation_id=request.operation_id
    JOIN harness.project_recovery_execution_approvals approval ON approval.review_id=review.id AND approval.organization_id=review.organization_id
    JOIN harness.project_recovery_operations op ON op.id=review.operation_id
    JOIN harness.project_content_placement placement ON placement.organization_id=op.organization_id AND placement.project_id=op.project_id
    WHERE request.operation_id=h.operation_id AND request.status='ready' AND request.organization_id=org AND review.organization_id=org
      AND op.phase='published' AND op.target_activated_at IS NOT NULL
      AND (op.recovery_mode='disaster' OR EXISTS(SELECT FROM harness.project_recovery_execution_transfers transfer WHERE transfer.operation_id=op.id))
      AND (review.runtime_id,review.target_node_id,review.target_epoch,review.point_id)=(runtime,node,op.target_epoch,op.point_id)
      AND (placement.runtime_id,placement.node_id,placement.volume_id,placement.writer_epoch)=(runtime,node,op.target_volume_id,review.target_epoch)))
$$;

CREATE OR REPLACE FUNCTION harness.recovery_execution_allowed(org uuid,runtime uuid,node uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT harness.project_recovery_execution_allowed(org,runtime,node) AND harness.personal_recovery_execution_allowed(org,runtime,node)
$$;

CREATE OR REPLACE FUNCTION harness.validate_recovery_source_isolation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE prior harness.recovery_source_isolations;
BEGIN
 SELECT * INTO prior FROM harness.recovery_source_isolations WHERE operation_id=NEW.operation_id;
 IF FOUND THEN
  IF to_jsonb(prior)=to_jsonb(NEW) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'Physical isolation evidence is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.scope_kind='project' THEN
  IF NOT EXISTS(SELECT FROM harness.project_recovery_isolations a JOIN harness.project_recovery_operations r ON r.id=a.operation_id
    WHERE (a.operation_id,a.organization_id,r.project_id,r.runtime_id,a.source_node_id,a.source_generation,a.source_epoch,
      a.point_id,a.policy_revision,a.method,a.evidence_reference,a.confirmed_by,a.confirmed_at,a.acknowledge_data_loss)=
      (NEW.operation_id,NEW.organization_id,NEW.scope_id,NEW.runtime_id,NEW.source_node_id,NEW.source_generation,NEW.source_epoch,
      NEW.point_id,NEW.policy_revision,NEW.method,NEW.evidence_reference,NEW.confirmed_by,NEW.confirmed_at,NEW.acknowledge_data_loss)
    AND r.organization_id=a.organization_id AND r.source_node_id=a.source_node_id AND r.source_epoch=a.source_epoch
    AND r.point_id=a.point_id AND NEW.project_isolation_id=a.operation_id)
  THEN RAISE EXCEPTION 'Project physical isolation requires its original receipt' USING ERRCODE='23514'; END IF;
 ELSE
  IF NOT EXISTS(SELECT FROM harness.personal_recovery_operations r JOIN harness.instances i
    ON i.organization_id=r.organization_id AND i.runtime_id=r.runtime_id
    WHERE r.id=NEW.operation_id AND r.phase='prepared' AND r.target_verified_at IS NOT NULL
      AND (r.organization_id,r.runtime_id,r.runtime_id,r.source_node_id,r.source_generation,r.source_epoch,r.point_id,harness.personal_recovery_policy_revision(r.id,r.policy_revision))=
        (NEW.organization_id,NEW.scope_id,NEW.runtime_id,NEW.source_node_id,NEW.source_generation,NEW.source_epoch,NEW.point_id,NEW.policy_revision)
      AND i.user_id=r.user_id AND i.assigned_node_id=r.source_node_id AND i.generation=r.source_generation)
  THEN RAISE EXCEPTION 'Personal physical isolation requires its verified candidate and current generation' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION harness.bind_runtime_environment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.runtime_id IS DISTINCT FROM OLD.runtime_id
      OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
      RAISE EXCEPTION 'runtime environment owner is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.assigned_node_id IS DISTINCT FROM OLD.assigned_node_id THEN
      IF OLD.observed_state<>'stopped' AND NOT EXISTS(SELECT FROM harness.project_recovery_operations r
        WHERE r.id::text=current_setting('hgw.recovery_operation',true) AND r.recovery_mode='disaster'
        AND (r.organization_id,r.runtime_id,r.source_node_id,r.target_node_id)=(NEW.organization_id,NEW.runtime_id,OLD.assigned_node_id,NEW.assigned_node_id)
        AND OLD.desired_state='stopped' AND OLD.runtime_token_hash IS NULL AND NEW.observed_state='stopped'
        AND harness.project_recovery_owner(r.organization_id,r.project_id,r.runtime_id,r.source_node_id,r.source_volume_id,r.source_epoch,r.target_node_id,r.target_volume_id,r.target_epoch))
        AND NOT (OLD.user_id IS NOT NULL AND OLD.desired_state='stopped' AND OLD.runtime_token_hash IS NULL
          AND NEW.observed_state='stopped' AND NEW.generation=OLD.generation+1
          AND harness.personal_recovery_owner(NEW.organization_id,NEW.runtime_id,NEW.user_id,OLD.assigned_node_id,NEW.assigned_node_id)) THEN
        RAISE EXCEPTION 'runtime environment reassignment requires a stopped instance' USING ERRCODE='23514';
      END IF;
      UPDATE harness.runtime_environments SET node_id=NEW.assigned_node_id
        WHERE id=NEW.runtime_id AND organization_id=NEW.organization_id AND retired_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'runtime environment is retired' USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.runtime_id IS NOT NULL THEN
    RAISE EXCEPTION 'runtime environment identity is assigned by the database' USING ERRCODE='23514';
  END IF;
  NEW.runtime_id=NEW.id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION harness.check_document_scope_placement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.scope_kind='project' AND
    (OLD.organization_id,OLD.scope_kind,OLD.scope_id,OLD.root_id,OLD.project_runtime_id)=(NEW.organization_id,NEW.scope_kind,NEW.scope_id,NEW.root_id,NEW.project_runtime_id)
    AND harness.project_recovery_owner(OLD.organization_id,OLD.scope_id,OLD.project_runtime_id,OLD.node_id,OLD.volume_id,OLD.writer_epoch,
      NEW.node_id,NEW.volume_id,NEW.writer_epoch) THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.scope_kind='personal'
    AND (OLD.organization_id,OLD.scope_kind,OLD.scope_id,OLD.root_id,OLD.project_runtime_id) IS NOT DISTINCT FROM
      (NEW.organization_id,NEW.scope_kind,NEW.scope_id,NEW.root_id,NEW.project_runtime_id)
    AND EXISTS(SELECT FROM harness.personal_recovery_operations r WHERE r.id::text=current_setting('hgw.personal_recovery_operation',true)
      AND (r.organization_id,r.user_id,r.source_node_id,r.source_document_root,r.source_volume_id,r.source_document_epoch,
        r.target_node_id,r.target_volume_id,r.target_document_epoch)=
        (OLD.organization_id,OLD.scope_id,OLD.node_id,OLD.root_id,OLD.volume_id,OLD.writer_epoch,NEW.node_id,NEW.volume_id,NEW.writer_epoch)
      AND harness.personal_recovery_owner(r.organization_id,r.runtime_id,r.user_id,r.source_node_id,r.target_node_id)) THEN RETURN NEW; END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Document scope publication is immutable'; END IF;
  IF NEW.scope_kind='personal' AND NOT EXISTS(SELECT FROM harness.users u WHERE u.organization_id=NEW.organization_id AND u.id=NEW.scope_id)
    OR NEW.scope_kind='project' AND NOT EXISTS(SELECT FROM harness.runtime_environments r
       WHERE r.organization_id=NEW.organization_id AND r.node_id=NEW.node_id AND r.owner_kind='project'
         AND r.owner_id=NEW.scope_id AND r.id=NEW.project_runtime_id AND r.retired_at IS NULL)
  THEN RAISE EXCEPTION 'Document scope owner does not match its assigned node'; END IF;
  IF harness.historical_personal_document_proven(NEW.organization_id,NEW.node_id,NEW.scope_kind,NEW.scope_id,NEW.root_id,NEW.volume_id) THEN RETURN NEW; END IF;
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

CREATE FUNCTION harness.retain_personal_recovery_owner() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT FROM harness.personal_directory_placement p WHERE p.organization_id=OLD.organization_id AND p.runtime_id=OLD.id)
   AND (NEW.id,NEW.organization_id,NEW.owner_kind,NEW.owner_id) IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.owner_kind,OLD.owner_id)
 THEN RAISE EXCEPTION 'Published personal Runtime identity is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.node_id<>OLD.node_id AND EXISTS(SELECT FROM harness.personal_directory_placement p WHERE p.organization_id=OLD.organization_id AND p.runtime_id=OLD.id)
   AND NOT harness.personal_recovery_owner(OLD.organization_id,OLD.id,OLD.owner_id,OLD.node_id,NEW.node_id)
 THEN RAISE EXCEPTION 'Published personal Runtime relocation requires isolated recovery' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER retain_personal_recovery_owner BEFORE UPDATE ON harness.runtime_environments
 FOR EACH ROW EXECUTE FUNCTION harness.retain_personal_recovery_owner();
CREATE FUNCTION harness.keep_personal_recovery_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Personal recovery history is immutable'; END IF;
 IF (to_jsonb(NEW)-ARRAY['phase','target_files_digest','target_evidence_digest','target_document_digest','target_verified_at','target_activated_at',
   'activation_approved_by','activation_approved_at','old_session_count','suspended_environment_keys','retry_at','last_error','published_at'])<>
   (to_jsonb(OLD)-ARRAY['phase','target_files_digest','target_evidence_digest','target_document_digest','target_verified_at','target_activated_at',
   'activation_approved_by','activation_approved_at','old_session_count','suspended_environment_keys','retry_at','last_error','published_at'])
 THEN RAISE EXCEPTION 'Personal recovery coordinates are immutable'; END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(NEW.suspended_environment_keys) item WHERE jsonb_typeof(item)<>'string' OR item#>>'{}' !~ '^[A-Z_][A-Z0-9_]{0,127}$')
 THEN RAISE EXCEPTION 'Suspended environment keys must be bounded setting names'; END IF;
 IF OLD.target_verified_at IS NOT NULL AND
   (OLD.target_files_digest,OLD.target_evidence_digest,OLD.target_document_digest,OLD.target_verified_at,OLD.old_session_count,OLD.suspended_environment_keys) IS DISTINCT FROM
   (NEW.target_files_digest,NEW.target_evidence_digest,NEW.target_document_digest,NEW.target_verified_at,NEW.old_session_count,NEW.suspended_environment_keys)
 THEN RAISE EXCEPTION 'Personal target proof is immutable'; END IF;
 IF OLD.activation_approved_at IS NOT NULL AND (OLD.activation_approved_by,OLD.activation_approved_at) IS DISTINCT FROM
   (NEW.activation_approved_by,NEW.activation_approved_at) THEN RAISE EXCEPTION 'Personal activation approval is immutable'; END IF;
 IF NEW.phase<>OLD.phase AND NOT (
   OLD.phase='preparing' AND NEW.phase IN('prepared','cancelled') OR OLD.phase='prepared' AND NEW.phase IN('externally-fenced','cancelled')
   OR OLD.phase='externally-fenced' AND NEW.phase='activating' OR OLD.phase='activating' AND NEW.phase='switching'
   OR OLD.phase='switching' AND NEW.phase='published') THEN RAISE EXCEPTION 'Invalid personal recovery phase'; END IF;
 IF NEW.phase IN('prepared','externally-fenced','activating','switching','published') AND
   (NEW.target_verified_at IS NULL OR NEW.target_files_digest IS NULL OR NEW.target_evidence_digest IS NULL OR NEW.target_document_digest IS NULL OR NEW.old_session_count IS NULL)
 THEN RAISE EXCEPTION 'Personal recovery requires verified target files'; END IF;
 IF NEW.phase IN('externally-fenced','activating','switching','published') AND NOT EXISTS(
   SELECT FROM harness.recovery_source_isolations a WHERE a.operation_id=NEW.id AND a.scope_kind='personal'
     AND a.organization_id=NEW.organization_id AND a.runtime_id=NEW.runtime_id AND a.point_id=NEW.point_id)
 THEN RAISE EXCEPTION 'Personal recovery requires physical isolation'; END IF;
 IF NEW.phase IN('activating','switching','published') AND (NEW.activation_approved_by IS NULL OR NEW.activation_approved_at IS NULL)
 THEN RAISE EXCEPTION 'Personal recovery requires current activation approval'; END IF;
 IF OLD.phase='published' AND (NEW.target_activated_at,NEW.published_at) IS DISTINCT FROM (OLD.target_activated_at,OLD.published_at)
 THEN RAISE EXCEPTION 'Personal publication evidence is immutable'; END IF;
 IF NEW.phase='published' AND (NEW.target_activated_at IS NULL OR NEW.published_at IS NULL OR NEW.activation_approved_at IS NULL)
 THEN RAISE EXCEPTION 'Personal recovery requires activated destination'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER keep_personal_recovery_evidence BEFORE UPDATE OR DELETE ON harness.personal_recovery_operations
 FOR EACH ROW EXECUTE FUNCTION harness.keep_personal_recovery_evidence();
CREATE FUNCTION harness.validate_personal_execution_hold() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM harness.personal_recovery_operations r JOIN harness.recovery_source_isolations a ON a.operation_id=r.id
   WHERE r.id=NEW.operation_id AND r.organization_id=NEW.organization_id AND r.runtime_id=NEW.runtime_id AND a.scope_kind='personal')
 THEN RAISE EXCEPTION 'Personal execution hold requires source isolation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_personal_execution_hold BEFORE INSERT ON harness.personal_recovery_execution_holds
 FOR EACH ROW EXECUTE FUNCTION harness.validate_personal_execution_hold();

CREATE FUNCTION harness.validate_personal_document_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM harness.personal_recovery_operations r WHERE r.id=NEW.operation_id
   AND (r.organization_id,r.user_id,r.source_node_id,r.source_document_root,r.source_volume_id,r.source_document_epoch,
     r.target_node_id,r.target_volume_id,r.target_document_epoch,r.target_document_digest)=
     (NEW.organization_id,NEW.user_id,NEW.source_node_id,NEW.root_id,NEW.source_volume_id,NEW.source_epoch,
     NEW.target_node_id,NEW.target_volume_id,NEW.target_epoch,NEW.document_digest)
   AND r.document_receipt_operation_id IS NULL
   AND harness.personal_recovery_owner(r.organization_id,r.runtime_id,r.user_id,r.source_node_id,r.target_node_id))
 THEN RAISE EXCEPTION 'Personal document publication requires the exact isolated target proof' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_personal_document_receipt BEFORE INSERT ON harness.personal_recovery_document_receipts
 FOR EACH ROW EXECUTE FUNCTION harness.validate_personal_document_receipt();
