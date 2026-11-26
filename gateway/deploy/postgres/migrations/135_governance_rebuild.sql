-- A fresh governance database opens only after explicit recovery review; old writer and bearer authority is never imported.
CREATE TABLE harness.governance_rebuild_operations (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES harness.organizations(id),
 source_node_id uuid NOT NULL,target_node_id uuid NOT NULL,point_id uuid NOT NULL,
 manifest_digest text NOT NULL CHECK(manifest_digest~'^[a-f0-9]{64}$'),schema_digest text NOT NULL CHECK(schema_digest~'^[a-f0-9]{64}$'),
 source_watermark numeric(20,0) NOT NULL CHECK(source_watermark>=0),source_topology_revision bigint NOT NULL CHECK(source_topology_revision>0),
 recovery_epoch bigint NOT NULL CHECK(recovery_epoch>0),bootstrap_user_id uuid NOT NULL,
 isolation_method text NOT NULL CHECK(isolation_method IN('power-off','network-isolation')),
 evidence_reference text NOT NULL CHECK(length(evidence_reference) BETWEEN 1 AND 512),
 state text NOT NULL DEFAULT 'review' CHECK(state IN('review','released')),
 review_revision bigint NOT NULL DEFAULT 1 CHECK(review_revision>0),unrestored_domains jsonb NOT NULL CHECK(jsonb_typeof(unrestored_domains)='array'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),released_at timestamptz,
 CHECK(source_node_id<>target_node_id),UNIQUE(organization_id,recovery_epoch),
 FOREIGN KEY(organization_id,source_node_id) REFERENCES harness.compute_nodes(organization_id,id),
 FOREIGN KEY(organization_id,target_node_id) REFERENCES harness.compute_nodes(organization_id,id),
 FOREIGN KEY(bootstrap_user_id,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE INDEX governance_rebuild_in_review ON harness.governance_rebuild_operations(organization_id,recovery_epoch DESC) WHERE state='review';
CREATE TABLE harness.governance_rebuild_reconfiguration (
 operation_id uuid NOT NULL REFERENCES harness.governance_rebuild_operations(id),table_name text NOT NULL,
 record_digest text NOT NULL CHECK(record_digest~'^[a-f0-9]{64}$'),safe_record jsonb NOT NULL CHECK(jsonb_typeof(safe_record)='object'),
 PRIMARY KEY(operation_id,table_name,record_digest)
);
CREATE TABLE harness.governance_rebuild_accounts (
 operation_id uuid NOT NULL REFERENCES harness.governance_rebuild_operations(id),organization_id uuid NOT NULL,user_id uuid NOT NULL,
 source_role text NOT NULL CHECK(source_role IN('admin','member')),source_user_status text NOT NULL,
 source_member_status text NOT NULL,source_deleted_at timestamptz,source_password_available boolean NOT NULL,
 PRIMARY KEY(operation_id,user_id),FOREIGN KEY(user_id,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE TABLE harness.governance_rebuild_nodes (
 operation_id uuid NOT NULL REFERENCES harness.governance_rebuild_operations(id),organization_id uuid NOT NULL,node_id uuid NOT NULL,
 source_status text NOT NULL,PRIMARY KEY(operation_id,node_id),
 FOREIGN KEY(organization_id,node_id) REFERENCES harness.compute_nodes(organization_id,id)
);
CREATE TABLE harness.governance_rebuild_runtimes (
 id uuid PRIMARY KEY,operation_id uuid NOT NULL REFERENCES harness.governance_rebuild_operations(id),organization_id uuid NOT NULL,
 runtime_id uuid NOT NULL,node_id uuid NOT NULL,owner_kind text NOT NULL CHECK(owner_kind IN('user','project')),owner_id uuid NOT NULL,
 source_generation bigint NOT NULL CHECK(source_generation>0),writer_epoch bigint NOT NULL CHECK(writer_epoch>0),volume_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(operation_id,runtime_id),
 FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
 FOREIGN KEY(organization_id,node_id) REFERENCES harness.compute_nodes(organization_id,id)
);
CREATE TABLE harness.governance_rebuild_decisions (
 id uuid PRIMARY KEY,operation_id uuid NOT NULL REFERENCES harness.governance_rebuild_operations(id),organization_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),subject_kind text NOT NULL CHECK(subject_kind IN('account','node','runtime')),
 subject_id uuid NOT NULL,decision text NOT NULL CHECK(decision IN('restore','keep-disabled')),
 approved_by uuid NOT NULL,approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(operation_id,revision),FOREIGN KEY(approved_by,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE INDEX governance_rebuild_latest_decision ON harness.governance_rebuild_decisions(operation_id,subject_kind,subject_id,revision DESC);
CREATE TABLE harness.governance_rebuild_execution_holds (
 operation_id uuid PRIMARY KEY REFERENCES harness.governance_rebuild_runtimes(id),organization_id uuid NOT NULL,runtime_id uuid NOT NULL,
 FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id)
);
CREATE TABLE harness.governance_rebuild_data_bindings (
 runtime_operation_id uuid PRIMARY KEY REFERENCES harness.governance_rebuild_runtimes(id),organization_id uuid NOT NULL,
 runtime_id uuid NOT NULL,node_id uuid NOT NULL,binding_id uuid NOT NULL UNIQUE,
 evidence_digest text NOT NULL CHECK(evidence_digest~'^[a-f0-9]{64}$'),old_session_count bigint NOT NULL CHECK(old_session_count>=0),
 source_generation bigint NOT NULL CHECK(source_generation>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
 FOREIGN KEY(organization_id,node_id) REFERENCES harness.compute_nodes(organization_id,id)
);
CREATE TABLE harness.governance_rebuild_binding_requests (
 runtime_operation_id uuid PRIMARY KEY REFERENCES harness.governance_rebuild_runtimes(id),organization_id uuid NOT NULL,
 request_id uuid NOT NULL,requested_by uuid NOT NULL,requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 status text NOT NULL CHECK(status IN('queued','ready','failed')),error_code text,
 FOREIGN KEY(requested_by,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE TABLE harness.governance_rebuild_execution_requests (
 operation_id uuid PRIMARY KEY REFERENCES harness.governance_rebuild_execution_holds(operation_id),organization_id uuid NOT NULL,
 request_id uuid NOT NULL,requested_by uuid NOT NULL,requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 status text NOT NULL CHECK(status IN('queued','ready','failed')),review_id uuid,error_code text,
 FOREIGN KEY(requested_by,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE TABLE harness.governance_rebuild_execution_reviews (
 LIKE harness.project_recovery_execution_reviews INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 PRIMARY KEY(id),FOREIGN KEY(operation_id) REFERENCES harness.governance_rebuild_execution_holds(operation_id),
 FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
 FOREIGN KEY(organization_id,target_node_id) REFERENCES harness.compute_nodes(organization_id,id)
);
ALTER TABLE harness.governance_rebuild_execution_requests ADD FOREIGN KEY(review_id) REFERENCES harness.governance_rebuild_execution_reviews(id);
CREATE TABLE harness.governance_rebuild_execution_approvals (
 LIKE harness.project_recovery_execution_approvals INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 PRIMARY KEY(review_id),FOREIGN KEY(review_id) REFERENCES harness.governance_rebuild_execution_reviews(id),
 FOREIGN KEY(approved_by,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE TABLE harness.governance_rebuild_execution_item_approvals (
 LIKE harness.project_recovery_execution_item_approvals INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
 PRIMARY KEY(review_id,item_digest),FOREIGN KEY(review_id) REFERENCES harness.governance_rebuild_execution_reviews(id),
 FOREIGN KEY(approved_by,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE INDEX governance_rebuild_execution_queued ON harness.governance_rebuild_execution_requests(requested_at) WHERE status='queued';
CREATE INDEX governance_rebuild_execution_files ON harness.governance_rebuild_execution_reviews(organization_id,target_node_id,runtime_id);
DO $$ DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['accounts','nodes','runtimes','decisions','reconfiguration','data_bindings','execution_holds','execution_reviews','execution_approvals','execution_item_approvals'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_governance_rebuild_%I BEFORE UPDATE OR DELETE ON harness.governance_rebuild_%I FOR EACH ROW EXECUTE FUNCTION harness.preserve_disaster_receipt()',relation,relation);
 END LOOP;
END $$;
CREATE FUNCTION harness.keep_governance_rebuild_operation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['state','review_revision','released_at'])<>(to_jsonb(OLD)-ARRAY['state','review_revision','released_at'])
   OR NEW.review_revision<OLD.review_revision OR OLD.state='released' AND to_jsonb(NEW)<>to_jsonb(OLD)
 THEN RAISE EXCEPTION 'Governance rebuild evidence is immutable' USING ERRCODE='23514';END IF;
 IF NEW.state='released' AND NEW.released_at IS NULL THEN RAISE EXCEPTION 'Governance release requires its reviewed completion time' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER keep_governance_rebuild_operation BEFORE UPDATE OR DELETE ON harness.governance_rebuild_operations
 FOR EACH ROW EXECUTE FUNCTION harness.keep_governance_rebuild_operation();

ALTER TABLE harness.recovery_source_isolations
 DROP CONSTRAINT recovery_source_isolations_scope_kind_check,
 DROP CONSTRAINT recovery_source_isolations_check,
 ALTER COLUMN runtime_id DROP NOT NULL,
 ALTER COLUMN source_generation DROP NOT NULL,
 ALTER COLUMN source_epoch DROP NOT NULL,
 ALTER COLUMN policy_revision TYPE bigint,
 ADD CHECK(scope_kind IN('project','personal','governance')),
 ADD CHECK((scope_kind='governance' AND scope_id=organization_id AND runtime_id IS NULL AND source_generation IS NULL AND source_epoch IS NULL AND project_isolation_id IS NULL)
   OR (scope_kind<>'governance' AND runtime_id IS NOT NULL AND source_generation IS NOT NULL AND source_epoch IS NOT NULL
     AND ((scope_kind='project' AND project_isolation_id=operation_id) OR (scope_kind='personal' AND project_isolation_id IS NULL))));
CREATE OR REPLACE FUNCTION harness.validate_recovery_source_isolation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE prior harness.recovery_source_isolations;
BEGIN
 SELECT * INTO prior FROM harness.recovery_source_isolations WHERE operation_id=NEW.operation_id;
 IF FOUND THEN
  IF to_jsonb(prior)=to_jsonb(NEW) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'Physical isolation evidence is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.scope_kind='governance' THEN
  IF NOT EXISTS(SELECT FROM harness.governance_rebuild_operations r WHERE
    (r.id,r.organization_id,r.source_node_id,r.point_id,r.source_topology_revision,r.isolation_method,r.evidence_reference,r.bootstrap_user_id,r.created_at)=
    (NEW.operation_id,NEW.organization_id,NEW.source_node_id,NEW.point_id,NEW.policy_revision,NEW.method,NEW.evidence_reference,NEW.confirmed_by,NEW.confirmed_at)
    AND r.state='review' AND NEW.acknowledge_data_loss)
  THEN RAISE EXCEPTION 'Governance isolation requires its immutable rebuilding receipt' USING ERRCODE='23514'; END IF;
 ELSIF NEW.scope_kind='project' THEN
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

CREATE FUNCTION harness.governance_rebuild_execution_allowed(org uuid,runtime uuid,node uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT FROM (SELECT * FROM harness.governance_rebuild_operations WHERE organization_id=org ORDER BY recovery_epoch DESC LIMIT 1) operation
   WHERE operation.state<>'released' OR EXISTS(SELECT FROM harness.governance_rebuild_runtimes r
     WHERE r.operation_id=operation.id AND r.runtime_id=runtime AND NOT EXISTS(
       SELECT FROM harness.governance_rebuild_execution_requests request
       JOIN harness.governance_rebuild_execution_reviews review ON review.id=request.review_id AND review.operation_id=request.operation_id
       JOIN harness.governance_rebuild_execution_approvals approval ON approval.review_id=review.id AND approval.organization_id=org
       JOIN harness.runtime_environments e ON e.id=r.runtime_id AND e.organization_id=r.organization_id
       WHERE request.operation_id=r.id AND request.status='ready' AND request.organization_id=org
         AND (review.runtime_id,review.target_node_id,review.target_epoch,review.point_id)=(runtime,node,r.writer_epoch,operation.point_id)
         AND review.blockers='[]'::jsonb AND e.node_id=node AND e.retired_at IS NULL)
       AND NOT EXISTS(SELECT FROM harness.project_recovery_operations replacement
         WHERE replacement.organization_id=org AND replacement.runtime_id=runtime AND replacement.target_node_id=node
           AND replacement.target_epoch>r.source_generation AND replacement.phase='published' AND replacement.target_activated_at IS NOT NULL
           AND replacement.recovery_mode='disaster')
       AND NOT EXISTS(SELECT FROM harness.personal_recovery_operations replacement
         WHERE replacement.organization_id=org AND replacement.runtime_id=runtime AND replacement.target_node_id=node
           AND replacement.target_epoch>r.source_generation AND replacement.phase='published' AND replacement.target_activated_at IS NOT NULL)))
$$;
CREATE OR REPLACE FUNCTION harness.recovery_execution_allowed(org uuid,runtime uuid,node uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT harness.project_recovery_execution_allowed(org,runtime,node) AND harness.personal_recovery_execution_allowed(org,runtime,node)
   AND harness.governance_rebuild_execution_allowed(org,runtime,node)
$$;

-- Preserve the current governance-frozen set across an explicitly stopped planned relocation.
ALTER TABLE harness.project_recovery_execution_transfers
 ALTER COLUMN source_review_id DROP NOT NULL,
 ADD COLUMN source_governance_review_id uuid REFERENCES harness.governance_rebuild_execution_reviews(id),
 ADD CONSTRAINT recovery_execution_transfer_source CHECK((source_review_id IS NULL)<>(source_governance_review_id IS NULL));
CREATE OR REPLACE FUNCTION harness.guard_recovery_execution_transfer() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.source_governance_review_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT FROM harness.project_recovery_operations next
    JOIN harness.governance_rebuild_execution_reviews review ON review.id=NEW.source_governance_review_id
    JOIN harness.governance_rebuild_runtimes r ON r.id=review.operation_id
    JOIN harness.governance_rebuild_operations operation ON operation.id=r.operation_id
    JOIN harness.governance_rebuild_data_bindings binding ON binding.runtime_operation_id=r.id
    JOIN harness.governance_rebuild_execution_requests request ON request.operation_id=r.id AND request.review_id=review.id AND request.status='ready'
    JOIN harness.governance_rebuild_execution_approvals approval ON approval.review_id=review.id
    JOIN harness.project_content_placement p ON p.organization_id=next.organization_id AND p.project_id=next.project_id
    JOIN harness.instances i ON i.organization_id=next.organization_id AND i.runtime_id=next.runtime_id
    WHERE next.id=NEW.operation_id AND next.organization_id=NEW.organization_id AND next.runtime_id=NEW.runtime_id
      AND next.recovery_mode='planned' AND next.phase='prepared' AND operation.state='released'
      AND operation.organization_id=NEW.organization_id AND r.organization_id=NEW.organization_id AND r.owner_kind='project'
      AND operation.recovery_epoch=(SELECT max(recovery_epoch) FROM harness.governance_rebuild_operations WHERE organization_id=NEW.organization_id)
      AND (r.runtime_id,r.owner_id,r.node_id,r.volume_id,r.writer_epoch)=(next.runtime_id,next.project_id,next.source_node_id,next.source_volume_id,next.source_epoch)
      AND (review.organization_id,review.runtime_id,review.target_node_id,review.target_epoch,review.point_id)=
        (NEW.organization_id,next.runtime_id,next.source_node_id,next.source_epoch,operation.point_id)
      AND (binding.organization_id,binding.runtime_id,binding.node_id,binding.source_generation)=
        (NEW.organization_id,next.runtime_id,next.source_node_id,r.source_generation)
      AND review.old_session_count=binding.old_session_count AND review.blockers='[]'::jsonb
      AND request.organization_id=NEW.organization_id AND approval.organization_id=NEW.organization_id
      AND (p.runtime_id,p.node_id,p.volume_id,p.writer_epoch)=(next.runtime_id,next.source_node_id,next.source_volume_id,next.source_epoch)
      AND i.assigned_node_id=next.source_node_id AND i.generation>=r.source_generation)
  THEN RAISE EXCEPTION 'Planned recovery requires its current governance frozen review' USING ERRCODE='55000',CONSTRAINT='recovery_execution_transfer'; END IF;
  RETURN NEW;
 END IF;
 IF harness.governance_rebuild_execution_route(NEW.organization_id,NEW.runtime_id,(SELECT source_node_id FROM harness.project_recovery_operations WHERE id=NEW.operation_id)) IN('governance','blocked') THEN
  RAISE EXCEPTION 'Planned recovery cannot substitute an older scope review' USING ERRCODE='55000',CONSTRAINT='recovery_execution_transfer';
 END IF;
 IF NOT EXISTS(SELECT FROM harness.project_recovery_operations next
   JOIN harness.project_recovery_execution_reviews review ON review.id=NEW.source_review_id
   JOIN harness.project_recovery_operations prior ON prior.id=review.operation_id
   JOIN harness.project_recovery_execution_holds hold ON hold.operation_id=prior.id
   JOIN harness.project_content_placement b ON b.organization_id=next.organization_id AND b.project_id=next.project_id
   WHERE next.id=NEW.operation_id AND next.organization_id=NEW.organization_id AND next.runtime_id=NEW.runtime_id
     AND next.recovery_mode='planned' AND next.phase='prepared' AND prior.phase='published' AND prior.target_activated_at IS NOT NULL
     AND (review.organization_id,review.runtime_id,review.target_node_id,review.target_epoch)=(NEW.organization_id,NEW.runtime_id,next.source_node_id,next.source_epoch)
     AND (prior.project_id,prior.target_volume_id,prior.target_epoch)=(next.project_id,next.source_volume_id,next.source_epoch)
     AND (b.runtime_id,b.node_id,b.volume_id,b.writer_epoch)=(next.runtime_id,next.source_node_id,next.source_volume_id,next.source_epoch)
     AND NOT EXISTS(SELECT FROM harness.project_recovery_execution_reviews older WHERE older.operation_id=prior.id
       AND (older.created_at,older.id)<(review.created_at,review.id)))
 THEN RAISE EXCEPTION 'Planned recovery requires its current source frozen review' USING ERRCODE='55000',CONSTRAINT='recovery_execution_transfer'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION harness.governance_rebuild_transfer_covers(org uuid,replacement uuid,runtime_operation uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH RECURSIVE lineage AS (
  SELECT transfer.operation_id,transfer.source_review_id,transfer.source_governance_review_id
   FROM harness.project_recovery_execution_transfers transfer WHERE transfer.organization_id=org AND transfer.operation_id=replacement
  UNION
  SELECT previous.operation_id,previous.source_review_id,previous.source_governance_review_id FROM lineage child
   JOIN harness.project_recovery_execution_reviews review ON review.id=child.source_review_id AND review.organization_id=org
   JOIN harness.project_recovery_execution_transfers previous ON previous.operation_id=review.operation_id AND previous.organization_id=org
 ) SELECT EXISTS(SELECT FROM lineage JOIN harness.governance_rebuild_execution_reviews review ON review.id=lineage.source_governance_review_id
   WHERE review.organization_id=org AND review.operation_id=runtime_operation)
$$;
CREATE FUNCTION harness.governance_rebuild_execution_route(org uuid,runtime uuid,node uuid)
RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT CASE WHEN operation.state<>'released' THEN 'blocked'
   WHEN r.id IS NULL THEN 'ordinary'
   WHEN EXISTS(SELECT FROM harness.project_recovery_operations replacement
     JOIN harness.project_content_placement p ON p.organization_id=replacement.organization_id AND p.project_id=replacement.project_id
     JOIN harness.runtime_environments e ON e.organization_id=p.organization_id AND e.id=p.runtime_id
     JOIN harness.instances i ON i.organization_id=e.organization_id AND i.runtime_id=e.id
     WHERE replacement.organization_id=org AND replacement.runtime_id=runtime AND replacement.target_node_id=node
       AND (replacement.recovery_mode='disaster' OR replacement.recovery_mode='planned'
         AND harness.governance_rebuild_transfer_covers(org,replacement.id,r.id)) AND replacement.target_epoch>r.writer_epoch
       AND replacement.phase='published' AND replacement.target_activated_at IS NOT NULL
       AND (p.runtime_id,p.node_id,p.volume_id,p.writer_epoch)=(runtime,node,replacement.target_volume_id,replacement.target_epoch)
       AND e.node_id=node AND i.assigned_node_id=node AND i.generation>=r.source_generation)
   OR EXISTS(SELECT FROM harness.personal_recovery_operations replacement
     JOIN harness.personal_directory_placement p ON p.organization_id=replacement.organization_id AND p.runtime_id=replacement.runtime_id
     JOIN harness.runtime_environments e ON e.organization_id=p.organization_id AND e.id=p.runtime_id
     JOIN harness.instances i ON i.organization_id=e.organization_id AND i.runtime_id=e.id
     WHERE replacement.organization_id=org AND replacement.runtime_id=runtime AND replacement.target_node_id=node
       AND replacement.target_epoch>r.source_generation AND replacement.phase='published' AND replacement.target_activated_at IS NOT NULL
       AND p.node_id=node AND p.owner_id=replacement.user_id AND e.node_id=node AND e.owner_id=replacement.user_id
       AND i.assigned_node_id=node AND i.generation>=replacement.target_epoch) THEN 'scope'
   ELSE 'governance' END
   FROM (SELECT * FROM harness.governance_rebuild_operations WHERE organization_id=org ORDER BY recovery_epoch DESC LIMIT 1) operation
   LEFT JOIN harness.governance_rebuild_runtimes r ON r.operation_id=operation.id AND r.runtime_id=runtime),'ordinary')
$$;
CREATE OR REPLACE FUNCTION harness.governance_rebuild_execution_allowed(org uuid,runtime uuid,node uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT FROM (SELECT * FROM harness.governance_rebuild_operations WHERE organization_id=org ORDER BY recovery_epoch DESC LIMIT 1) operation
   JOIN harness.governance_rebuild_runtimes r ON r.operation_id=operation.id AND r.runtime_id=runtime
   JOIN harness.governance_rebuild_data_bindings binding ON binding.runtime_operation_id=r.id AND binding.organization_id=org
     AND binding.runtime_id=runtime AND binding.node_id=node AND binding.source_generation=r.source_generation
   JOIN harness.governance_rebuild_execution_requests request ON request.operation_id=r.id AND request.organization_id=org AND request.status='ready'
   JOIN harness.governance_rebuild_execution_reviews review ON review.id=request.review_id AND review.operation_id=r.id
   JOIN harness.governance_rebuild_execution_approvals approval ON approval.review_id=review.id AND approval.organization_id=org
   JOIN harness.runtime_environments e ON e.id=r.runtime_id AND e.organization_id=r.organization_id
   WHERE operation.state='released' AND (review.runtime_id,review.target_node_id,review.target_epoch,review.point_id)=(runtime,node,r.writer_epoch,operation.point_id)
     AND review.blockers='[]'::jsonb AND e.node_id=node AND e.node_id=r.node_id AND e.retired_at IS NULL
     AND e.owner_kind=r.owner_kind AND e.owner_id=r.owner_id
     AND ((e.owner_kind='project' AND EXISTS(SELECT FROM harness.project_content_placement p WHERE p.organization_id=org
       AND p.project_id=r.owner_id AND p.runtime_id=runtime AND p.node_id=node AND p.writer_epoch=r.writer_epoch AND p.volume_id=r.volume_id))
       OR (e.owner_kind='user' AND EXISTS(SELECT FROM harness.personal_directory_placement p WHERE p.organization_id=org
         AND p.owner_id=r.owner_id AND p.runtime_id=runtime AND p.node_id=node))))
$$;
CREATE OR REPLACE FUNCTION harness.recovery_execution_allowed(org uuid,runtime uuid,node uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT CASE harness.governance_rebuild_execution_route(org,runtime,node)
   WHEN 'blocked' THEN false WHEN 'governance' THEN harness.governance_rebuild_execution_allowed(org,runtime,node)
   ELSE harness.project_recovery_execution_allowed(org,runtime,node) AND harness.personal_recovery_execution_allowed(org,runtime,node) END
$$;

ALTER TABLE harness.project_recovery_operations ADD COLUMN target_execution_transfer_digest text CHECK(target_execution_transfer_digest~'^[a-f0-9]{64}$');
CREATE OR REPLACE FUNCTION harness.keep_project_recovery_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Project recovery history is immutable'; END IF;
  IF (to_jsonb(NEW)-'target_activated_at'-'last_error')=(to_jsonb(OLD)-'target_activated_at'-'last_error') AND OLD.phase='published'
    AND OLD.target_activated_at IS NULL AND NEW.target_activated_at IS NOT NULL THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW)-ARRAY['retry_at','last_error'])=(to_jsonb(OLD)-ARRAY['retry_at','last_error']) THEN RETURN NEW; END IF;
  IF OLD.retirement_approved_at IS NOT NULL AND (NEW.retirement_approved_by,NEW.retirement_approved_at) IS DISTINCT FROM
    (OLD.retirement_approved_by,OLD.retirement_approved_at) THEN RAISE EXCEPTION 'Recovery retirement approval is immutable'; END IF;
  IF (to_jsonb(NEW)-ARRAY['retirement_approved_by','retirement_approved_at','last_error','retry_at','target_port_base','target_files_digest','suspended_environment_keys','target_execution_transfer_digest','source_files_digest','phase','target_verified_at','target_schedule_digest','old_fenced_at','stopped_generation','stop_operation_id',
      'source_schedule_digest','published_at'])<>(to_jsonb(OLD)-ARRAY['retirement_approved_by','retirement_approved_at','last_error','retry_at','target_port_base','target_files_digest','suspended_environment_keys','target_execution_transfer_digest','source_files_digest','phase','target_verified_at','target_schedule_digest','old_fenced_at',
      'stopped_generation','stop_operation_id','source_schedule_digest','published_at']) OR
    OLD.target_verified_at IS NOT NULL AND (NEW.target_verified_at,NEW.target_schedule_digest,NEW.target_files_digest,NEW.target_port_base,NEW.suspended_environment_keys,NEW.target_execution_transfer_digest) IS DISTINCT FROM (OLD.target_verified_at,OLD.target_schedule_digest,OLD.target_files_digest,OLD.target_port_base,OLD.suspended_environment_keys,OLD.target_execution_transfer_digest)
    OR OLD.old_fenced_at IS NOT NULL AND (NEW.old_fenced_at,NEW.stopped_generation,NEW.stop_operation_id,NEW.source_schedule_digest,NEW.source_files_digest)
       IS DISTINCT FROM (OLD.old_fenced_at,OLD.stopped_generation,OLD.stop_operation_id,OLD.source_schedule_digest,OLD.source_files_digest)
    OR NOT ((OLD.phase,NEW.phase) IN (('prepared','target-ready'),('prepared','cancelled'),('target-ready','cancelled'),
      ('target-ready','retire-approved'),('retire-approved','retiring'),('retire-approved','cancelled'),('retiring','retreat'),('retiring','old-fenced'),
      ('retreat','cancelled'),('retreat','old-fenced'),('old-fenced','switching'),('switching','published'),('prepared','externally-fenced'),('externally-fenced','disaster-ready'),('disaster-ready','switching')))
    THEN RAISE EXCEPTION 'Invalid project recovery transition'; END IF;
  IF NEW.phase='retire-approved' AND (NEW.retirement_approved_at IS NULL OR NEW.retirement_approved_by IS NULL)
    OR NEW.phase IN ('target-ready','disaster-ready') AND (NEW.target_verified_at IS NULL OR NEW.target_schedule_digest IS NULL OR NEW.target_files_digest IS NULL OR NEW.target_port_base IS NULL)
    OR NEW.phase='old-fenced' AND (NEW.old_fenced_at IS NULL OR NEW.stopped_generation IS NULL OR NEW.stop_operation_id IS NULL
      OR NEW.source_schedule_digest IS DISTINCT FROM NEW.target_schedule_digest OR NEW.source_files_digest IS DISTINCT FROM NEW.target_files_digest)
    OR NEW.phase='published' AND NEW.published_at IS NULL THEN RAISE EXCEPTION 'Incomplete project recovery evidence'; END IF;
  IF NEW.recovery_mode='disaster' AND (NEW.source_schedule_digest IS NOT NULL OR NEW.source_files_digest IS NOT NULL OR NEW.old_fenced_at IS NOT NULL OR NEW.stopped_generation IS NOT NULL OR NEW.stop_operation_id IS NOT NULL)
    THEN RAISE EXCEPTION 'External isolation cannot fabricate source evidence'; END IF;
  IF NEW.phase IN ('externally-fenced','disaster-ready') AND (NEW.recovery_mode<>'disaster' OR NOT EXISTS(
    SELECT FROM harness.project_recovery_isolations a JOIN harness.node_recovery_quarantines q ON q.organization_id=a.organization_id AND q.node_id=a.source_node_id
    WHERE a.operation_id=NEW.id AND a.organization_id=NEW.organization_id AND a.source_node_id=NEW.source_node_id
    AND a.source_epoch=NEW.source_epoch AND a.point_id=NEW.point_id)) THEN RAISE EXCEPTION 'External isolation evidence is missing'; END IF;
  IF NEW.recovery_mode='planned' AND NEW.phase IN ('externally-fenced','disaster-ready') OR NEW.recovery_mode='disaster' AND NEW.phase IN ('target-ready','retire-approved','retiring','retreat','old-fenced')
    THEN RAISE EXCEPTION 'Recovery mode does not allow this phase'; END IF;
  IF NEW.phase IN('target-ready','retire-approved','retiring','retreat','old-fenced','switching','published')
    AND EXISTS(SELECT FROM harness.governance_rebuild_runtimes r WHERE r.organization_id=NEW.organization_id AND r.runtime_id=NEW.runtime_id
      AND harness.governance_rebuild_transfer_covers(NEW.organization_id,NEW.id,r.id))
    AND NOT EXISTS(SELECT FROM harness.project_recovery_execution_transfers transfer
      LEFT JOIN harness.project_recovery_execution_reviews project ON project.id=transfer.source_review_id
      LEFT JOIN harness.governance_rebuild_execution_reviews governance ON governance.id=transfer.source_governance_review_id
      WHERE transfer.operation_id=NEW.id AND transfer.organization_id=NEW.organization_id AND transfer.runtime_id=NEW.runtime_id
        AND NEW.target_execution_transfer_digest=coalesce(project.policy_digest,governance.policy_digest))
  THEN RAISE EXCEPTION 'Target has not verified the transferred execution policy' USING ERRCODE='55000',CONSTRAINT='recovery_execution_transfer_protocol'; END IF;
  RETURN NEW;
END $$;
