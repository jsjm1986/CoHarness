-- A cancelled retirement must prove on the source volume whether the irreversible
-- fence ever landed; 'retreat' is that pending decision. The worker on the source
-- node resolves it: no fence row means 'retiring' never became irreversible and
-- the op can safely become 'cancelled'; a landed fence is completed to
-- 'old-fenced' from the fence's own evidence. The runtime stays frozen during
-- 'retreat' because fence state is not yet known.
CREATE OR REPLACE FUNCTION harness.keep_project_recovery_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
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
      ('target-ready','retire-approved'),('retire-approved','retiring'),('retire-approved','cancelled'),('retiring','retreat'),('retiring','old-fenced'),
      ('retreat','cancelled'),('retreat','old-fenced'),('old-fenced','switching'),('switching','published')))
    THEN RAISE EXCEPTION 'Invalid project recovery transition'; END IF;
  IF NEW.phase='retire-approved' AND (NEW.retirement_approved_at IS NULL OR NEW.retirement_approved_by IS NULL)
    OR NEW.phase='target-ready' AND (NEW.target_verified_at IS NULL OR NEW.target_schedule_digest IS NULL OR NEW.target_files_digest IS NULL OR NEW.target_port_base IS NULL)
    OR NEW.phase='old-fenced' AND (NEW.old_fenced_at IS NULL OR NEW.stopped_generation IS NULL OR NEW.stop_operation_id IS NULL
      OR NEW.source_schedule_digest IS DISTINCT FROM NEW.target_schedule_digest OR NEW.source_files_digest IS DISTINCT FROM NEW.target_files_digest)
    OR NEW.phase='published' AND NEW.published_at IS NULL THEN RAISE EXCEPTION 'Incomplete project recovery evidence'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION harness.block_retiring_project_runtime() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT FROM harness.project_recovery_operations r WHERE r.organization_id=NEW.organization_id AND r.runtime_id=NEW.runtime_id
    AND r.phase IN ('retiring','retreat','old-fenced','switching')) AND
    (NEW.runtime_token_hash IS NOT NULL OR NEW.desired_state<>'stopped' OR NEW.observed_state NOT IN ('stopped','stopping') OR NEW.generation<>OLD.generation)
    THEN RAISE EXCEPTION 'Project recovery holds the stopped Runtime generation'; END IF;
  RETURN NEW;
END $$;
ALTER TABLE harness.project_recovery_operations DROP CONSTRAINT project_recovery_operations_phase_check;
ALTER TABLE harness.project_recovery_operations ADD CONSTRAINT project_recovery_operations_phase_check
  CHECK (phase IN ('prepared','target-ready','retire-approved','retiring','retreat','old-fenced','switching','published','cancelled'));
