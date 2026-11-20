-- Recovery may admit new conversations while retaining the immutable pause of restored work.
CREATE TABLE harness.project_recovery_execution_requests (
 operation_id uuid PRIMARY KEY REFERENCES harness.project_recovery_execution_holds(operation_id),
 organization_id uuid NOT NULL REFERENCES harness.organizations(id),
 request_id uuid NOT NULL, requested_by uuid NOT NULL, requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 status text NOT NULL CHECK(status IN ('queued','ready','failed')), review_id uuid, error_code text,
 FOREIGN KEY(requested_by,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE TABLE harness.project_recovery_execution_reviews (
 id uuid PRIMARY KEY, operation_id uuid NOT NULL REFERENCES harness.project_recovery_execution_holds(operation_id),
 organization_id uuid NOT NULL, runtime_id uuid NOT NULL, target_node_id uuid NOT NULL,target_epoch bigint NOT NULL,
 point_id uuid NOT NULL, policy_digest text NOT NULL CHECK(policy_digest ~ '^[a-f0-9]{64}$'),
 composition_digest text NOT NULL CHECK(composition_digest ~ '^[a-f0-9]{64}$'),
 old_session_count bigint NOT NULL CHECK(old_session_count>=0),items jsonb NOT NULL CHECK(jsonb_typeof(items)='array'),
 blockers jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(blockers)='array'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
 FOREIGN KEY(organization_id,target_node_id) REFERENCES harness.compute_nodes(organization_id,id)
);
CREATE INDEX recovery_execution_queued ON harness.project_recovery_execution_requests(requested_at) WHERE status='queued';
ALTER TABLE harness.project_recovery_execution_requests ADD FOREIGN KEY(review_id) REFERENCES harness.project_recovery_execution_reviews(id);
CREATE INDEX recovery_execution_node_files ON harness.project_recovery_execution_reviews(organization_id,target_node_id,runtime_id);
CREATE TABLE harness.project_recovery_execution_approvals (
 review_id uuid PRIMARY KEY REFERENCES harness.project_recovery_execution_reviews(id),organization_id uuid NOT NULL,
 approved_by uuid NOT NULL, approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 mode text NOT NULL CHECK(mode='new-conversations-only'),
 FOREIGN KEY(approved_by,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE TABLE harness.project_recovery_execution_item_approvals (
 review_id uuid NOT NULL REFERENCES harness.project_recovery_execution_reviews(id),item_digest text NOT NULL CHECK(item_digest ~ '^[a-f0-9]{64}$'),
 organization_id uuid NOT NULL, approved_by uuid NOT NULL, evidence_reference text NOT NULL CHECK(length(evidence_reference) BETWEEN 1 AND 512),
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(review_id,item_digest),
 FOREIGN KEY(approved_by,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE TRIGGER immutable_recovery_execution_review BEFORE UPDATE OR DELETE ON harness.project_recovery_execution_reviews FOR EACH ROW EXECUTE FUNCTION harness.preserve_disaster_receipt();
CREATE TRIGGER immutable_recovery_execution_approval BEFORE UPDATE OR DELETE ON harness.project_recovery_execution_approvals FOR EACH ROW EXECUTE FUNCTION harness.preserve_disaster_receipt();
CREATE TRIGGER immutable_recovery_execution_item_approval BEFORE UPDATE OR DELETE ON harness.project_recovery_execution_item_approvals FOR EACH ROW EXECUTE FUNCTION harness.preserve_disaster_receipt();
CREATE FUNCTION harness.recovery_execution_allowed(org uuid,runtime uuid,node uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT NOT EXISTS(SELECT FROM (SELECT hold.* FROM harness.project_recovery_execution_holds hold
   JOIN harness.project_recovery_operations prior ON prior.id=hold.operation_id
   WHERE hold.organization_id=org AND hold.runtime_id=runtime ORDER BY prior.target_epoch DESC,prior.created_at DESC LIMIT 1) h
   WHERE h.organization_id=org AND h.runtime_id=runtime
   AND NOT EXISTS(SELECT FROM harness.project_recovery_execution_requests request
    JOIN harness.project_recovery_execution_reviews review ON review.id=request.review_id AND review.operation_id=request.operation_id
    JOIN harness.project_recovery_execution_approvals approval ON approval.review_id=review.id AND approval.organization_id=review.organization_id
    JOIN harness.project_recovery_operations op ON op.id=review.operation_id
    JOIN harness.project_content_placement placement ON placement.organization_id=op.organization_id AND placement.project_id=op.project_id
    WHERE request.operation_id=h.operation_id AND request.status='ready' AND request.organization_id=org AND review.organization_id=org
      AND op.phase='published' AND op.target_activated_at IS NOT NULL AND op.recovery_mode='disaster'
      AND (review.runtime_id,review.target_node_id,review.target_epoch,review.point_id)=(runtime,node,op.target_epoch,op.point_id)
      AND (placement.runtime_id,placement.node_id,placement.volume_id,placement.writer_epoch)=(runtime,node,op.target_volume_id,review.target_epoch)))
$$;
CREATE OR REPLACE FUNCTION harness.guard_disaster_runtime() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.desired_state='running' OR NEW.runtime_token_hash IS NOT NULL) AND (
   EXISTS(SELECT FROM harness.node_recovery_quarantines q WHERE q.organization_id=NEW.organization_id AND q.node_id=NEW.assigned_node_id)
   OR NOT harness.recovery_execution_allowed(NEW.organization_id,NEW.runtime_id,NEW.assigned_node_id))
 THEN RAISE EXCEPTION 'Runtime execution requires disaster recovery review' USING ERRCODE='55000',CONSTRAINT='runtime_recovery_review'; END IF;
 RETURN NEW;
END $$;
