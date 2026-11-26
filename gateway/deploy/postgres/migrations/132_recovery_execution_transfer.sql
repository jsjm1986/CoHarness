-- Planned relocation preserves disaster-frozen history and requires fresh destination execution approval.
CREATE TABLE harness.project_recovery_execution_transfers (
 operation_id uuid PRIMARY KEY REFERENCES harness.project_recovery_operations(id),
 organization_id uuid NOT NULL, runtime_id uuid NOT NULL,
 source_review_id uuid NOT NULL REFERENCES harness.project_recovery_execution_reviews(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id)
);
CREATE FUNCTION harness.guard_recovery_execution_transfer() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
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
CREATE TRIGGER validate_recovery_execution_transfer BEFORE INSERT ON harness.project_recovery_execution_transfers
 FOR EACH ROW EXECUTE FUNCTION harness.guard_recovery_execution_transfer();
CREATE TRIGGER immutable_recovery_execution_transfer BEFORE UPDATE OR DELETE ON harness.project_recovery_execution_transfers
 FOR EACH ROW EXECUTE FUNCTION harness.preserve_disaster_receipt();
ALTER TABLE harness.project_recovery_execution_holds DROP CONSTRAINT project_recovery_execution_holds_operation_id_fkey;
ALTER TABLE harness.project_recovery_execution_holds ADD FOREIGN KEY(operation_id) REFERENCES harness.project_recovery_operations(id);
CREATE FUNCTION harness.validate_recovery_execution_hold() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM harness.project_recovery_operations op WHERE op.id=NEW.operation_id
   AND op.organization_id=NEW.organization_id AND op.runtime_id=NEW.runtime_id AND (
     op.recovery_mode='disaster' AND EXISTS(SELECT FROM harness.project_recovery_isolations proof WHERE proof.operation_id=op.id)
     OR op.recovery_mode='planned' AND op.phase IN('old-fenced','switching','published')
       AND EXISTS(SELECT FROM harness.project_recovery_execution_transfers transfer WHERE transfer.operation_id=op.id)))
 THEN RAISE EXCEPTION 'Execution hold requires isolation or a fenced transfer' USING ERRCODE='55000',CONSTRAINT='recovery_execution_hold'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_recovery_execution_hold BEFORE INSERT ON harness.project_recovery_execution_holds
 FOR EACH ROW EXECUTE FUNCTION harness.validate_recovery_execution_hold();
CREATE OR REPLACE FUNCTION harness.recovery_execution_allowed(org uuid,runtime uuid,node uuid)
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
