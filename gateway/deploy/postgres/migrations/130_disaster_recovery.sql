-- Physical isolation is a separate operator attestation, never a fabricated source stop receipt.
ALTER TABLE harness.project_recovery_operations ADD COLUMN recovery_mode text NOT NULL DEFAULT 'planned' CHECK(recovery_mode IN ('planned','disaster'));
ALTER TABLE harness.project_recovery_operations ADD COLUMN suspended_environment_keys jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(suspended_environment_keys)='array' AND jsonb_array_length(suspended_environment_keys)<=128);
CREATE TABLE harness.project_recovery_isolations (
 operation_id uuid PRIMARY KEY REFERENCES harness.project_recovery_operations(id),
 organization_id uuid NOT NULL, source_node_id uuid NOT NULL, source_generation bigint NOT NULL CHECK(source_generation>0),
 source_epoch bigint NOT NULL CHECK(source_epoch>0), point_id uuid NOT NULL, policy_revision integer NOT NULL CHECK(policy_revision>0),
 method text NOT NULL CHECK(method IN ('power-off','network-isolation')), evidence_reference text NOT NULL CHECK(length(evidence_reference) BETWEEN 1 AND 512),
 confirmed_by uuid NOT NULL, confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(), acknowledge_data_loss boolean NOT NULL CHECK(acknowledge_data_loss),
 FOREIGN KEY(organization_id,source_node_id) REFERENCES harness.compute_nodes(organization_id,id),
 FOREIGN KEY(confirmed_by,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE TABLE harness.node_recovery_quarantines (
 organization_id uuid NOT NULL,node_id uuid NOT NULL,operation_id uuid NOT NULL REFERENCES harness.project_recovery_isolations(operation_id),
 PRIMARY KEY(organization_id,node_id),FOREIGN KEY(organization_id,node_id) REFERENCES harness.compute_nodes(organization_id,id)
);
CREATE TABLE harness.project_recovery_execution_holds (
 operation_id uuid PRIMARY KEY REFERENCES harness.project_recovery_isolations(operation_id),organization_id uuid NOT NULL,runtime_id uuid NOT NULL,
 blockers jsonb NOT NULL DEFAULT '["execution-review-required"]' CHECK(jsonb_typeof(blockers)='array'),
 FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id)
);
CREATE FUNCTION harness.preserve_disaster_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Disaster recovery evidence is immutable'; END $$;
CREATE TRIGGER immutable_recovery_isolation BEFORE UPDATE OR DELETE ON harness.project_recovery_isolations FOR EACH ROW EXECUTE FUNCTION harness.preserve_disaster_receipt();
CREATE TRIGGER immutable_node_quarantine BEFORE UPDATE OR DELETE ON harness.node_recovery_quarantines FOR EACH ROW EXECUTE FUNCTION harness.preserve_disaster_receipt();
CREATE TRIGGER immutable_recovery_execution_hold BEFORE UPDATE OR DELETE ON harness.project_recovery_execution_holds FOR EACH ROW EXECUTE FUNCTION harness.preserve_disaster_receipt();
CREATE FUNCTION harness.guard_disaster_node() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE node uuid;
BEGIN
 IF TG_TABLE_NAME='compute_nodes' THEN node:=NEW.id; ELSE node:=NEW.node_id; END IF;
 IF EXISTS(SELECT FROM harness.node_recovery_quarantines q WHERE q.organization_id=NEW.organization_id AND q.node_id=node) THEN
  IF TG_TABLE_NAME='compute_nodes' THEN
   IF NEW.status='offline' THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='node_agent_enrollments' THEN
   IF NEW.consumed_at IS NOT NULL AND EXISTS(SELECT FROM harness.node_agents a WHERE a.organization_id=NEW.organization_id AND a.node_id=node
     AND a.revision>NEW.revision AND a.credential_hash IS NULL AND a.revoked_at IS NOT NULL) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='node_agents' THEN
   IF NEW.credential_hash IS NULL AND NEW.connection_id IS NULL AND NEW.lease_expires_at IS NULL AND NEW.revoked_at IS NOT NULL THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'The source computer is quarantined after disaster recovery' USING ERRCODE='55000',CONSTRAINT='node_recovery_quarantined';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER disaster_compute_node BEFORE INSERT OR UPDATE ON harness.compute_nodes FOR EACH ROW EXECUTE FUNCTION harness.guard_disaster_node();
CREATE TRIGGER disaster_node_agent BEFORE INSERT OR UPDATE ON harness.node_agents FOR EACH ROW EXECUTE FUNCTION harness.guard_disaster_node();
CREATE TRIGGER disaster_node_enrollment BEFORE INSERT OR UPDATE ON harness.node_agent_enrollments FOR EACH ROW EXECUTE FUNCTION harness.guard_disaster_node();
-- A retired physical writer remains observable without retaining execution or enrollment authority.
CREATE FUNCTION harness.node_physically_isolated(organization uuid,node uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT FROM harness.compute_nodes n
   JOIN harness.node_recovery_quarantines q ON q.organization_id=n.organization_id AND q.node_id=n.id
   JOIN harness.project_recovery_isolations a ON a.operation_id=q.operation_id
     AND a.organization_id=q.organization_id AND a.source_node_id=q.node_id
   WHERE n.organization_id=organization AND n.id=node AND n.status='offline' AND a.acknowledge_data_loss
     AND NOT EXISTS(SELECT FROM harness.instances i WHERE i.organization_id=n.organization_id AND i.assigned_node_id=n.id
       AND (i.desired_state<>'stopped' OR i.runtime_token_hash IS NOT NULL))
     AND NOT EXISTS(SELECT FROM harness.node_agents agent WHERE agent.organization_id=n.organization_id AND agent.node_id=n.id
       AND (agent.credential_hash IS NOT NULL OR agent.revoked_at IS NULL OR agent.connection_id IS NOT NULL OR agent.lease_expires_at IS NOT NULL))
     AND NOT EXISTS(SELECT FROM harness.node_agent_enrollments e WHERE e.organization_id=n.organization_id AND e.node_id=n.id AND e.consumed_at IS NULL))
$$;
CREATE OR REPLACE FUNCTION harness.guard_deployment_topology() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.enabled AND EXISTS(SELECT FROM harness.node_recovery_quarantines q
    WHERE q.organization_id=NEW.organization_id AND q.node_id=NEW.primary_node_id) THEN
    RAISE EXCEPTION 'A quarantined computer cannot serve as primary' USING ERRCODE='55000',CONSTRAINT='deployment_primary_quarantined';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.enabled AND NEW.enabled AND OLD.primary_node_id IS DISTINCT FROM NEW.primary_node_id THEN
      RAISE EXCEPTION 'disable aggregation before changing the primary computer' USING ERRCODE='55000',CONSTRAINT='deployment_primary_immutable';
    END IF;
    IF OLD.enabled AND NOT NEW.enabled AND EXISTS(SELECT FROM harness.node_agents a
      WHERE a.organization_id=NEW.organization_id AND a.attachment_state<>'detached'
        AND NOT harness.node_physically_isolated(a.organization_id,a.node_id)) THEN
      RAISE EXCEPTION 'detach computers before disabling aggregation' USING ERRCODE='55000',CONSTRAINT='deployment_computers_attached';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER guard_deployment_topology ON harness.deployment_topology;
CREATE TRIGGER guard_deployment_topology BEFORE INSERT OR UPDATE OF enabled,primary_node_id ON harness.deployment_topology
  FOR EACH ROW EXECUTE FUNCTION harness.guard_deployment_topology();
CREATE FUNCTION harness.guard_disaster_runtime() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (NEW.desired_state='running' OR NEW.runtime_token_hash IS NOT NULL) AND (
   EXISTS(SELECT FROM harness.node_recovery_quarantines q WHERE q.organization_id=NEW.organization_id AND q.node_id=NEW.assigned_node_id)
   OR EXISTS(SELECT FROM harness.project_recovery_execution_holds h WHERE h.organization_id=NEW.organization_id AND h.runtime_id=NEW.runtime_id))
 THEN RAISE EXCEPTION 'Runtime execution requires disaster recovery review' USING ERRCODE='55000',CONSTRAINT='runtime_recovery_review'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER disaster_runtime_admission BEFORE INSERT OR UPDATE ON harness.instances FOR EACH ROW EXECUTE FUNCTION harness.guard_disaster_runtime();
CREATE OR REPLACE FUNCTION harness.node_execution_available(organization uuid,node uuid)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM harness.compute_nodes n
    JOIN harness.organizations o ON o.id=n.organization_id AND o.status='active'
    LEFT JOIN harness.node_agents a ON a.organization_id=n.organization_id AND a.node_id=n.id
    WHERE n.organization_id=organization AND n.id=node AND n.status='active'
      AND NOT EXISTS(SELECT FROM harness.node_recovery_quarantines q WHERE q.organization_id=organization AND q.node_id=node)
      AND (a.node_id IS NULL OR a.attachment_state IN ('pending','detached')
        OR (a.revoked_at IS NULL AND a.credential_hash IS NOT NULL AND a.connection_id IS NOT NULL
          AND a.lease_expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM harness.deployment_topology t
            WHERE t.organization_id=organization AND (t.enabled OR t.legacy_initialization_required)))))
$$;
CREATE OR REPLACE FUNCTION harness.keep_project_recovery_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Project recovery history is immutable'; END IF;
  IF (to_jsonb(NEW)-'target_activated_at'-'last_error')=(to_jsonb(OLD)-'target_activated_at'-'last_error') AND OLD.phase='published'
    AND OLD.target_activated_at IS NULL AND NEW.target_activated_at IS NOT NULL THEN RETURN NEW; END IF;
  IF (to_jsonb(NEW)-ARRAY['retry_at','last_error'])=(to_jsonb(OLD)-ARRAY['retry_at','last_error']) THEN RETURN NEW; END IF;
  IF OLD.retirement_approved_at IS NOT NULL AND (NEW.retirement_approved_by,NEW.retirement_approved_at) IS DISTINCT FROM
    (OLD.retirement_approved_by,OLD.retirement_approved_at) THEN RAISE EXCEPTION 'Recovery retirement approval is immutable'; END IF;
  IF (to_jsonb(NEW)-ARRAY['retirement_approved_by','retirement_approved_at','last_error','retry_at','target_port_base','target_files_digest','suspended_environment_keys','source_files_digest','phase','target_verified_at','target_schedule_digest','old_fenced_at','stopped_generation','stop_operation_id',
      'source_schedule_digest','published_at'])<>(to_jsonb(OLD)-ARRAY['retirement_approved_by','retirement_approved_at','last_error','retry_at','target_port_base','target_files_digest','suspended_environment_keys','source_files_digest','phase','target_verified_at','target_schedule_digest','old_fenced_at',
      'stopped_generation','stop_operation_id','source_schedule_digest','published_at']) OR
    OLD.target_verified_at IS NOT NULL AND (NEW.target_verified_at,NEW.target_schedule_digest,NEW.target_files_digest,NEW.target_port_base,NEW.suspended_environment_keys) IS DISTINCT FROM (OLD.target_verified_at,OLD.target_schedule_digest,OLD.target_files_digest,OLD.target_port_base,OLD.suspended_environment_keys)
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
  RETURN NEW;
END $$;

ALTER TABLE harness.project_recovery_operations DROP CONSTRAINT project_recovery_operations_phase_check;
ALTER TABLE harness.project_recovery_operations ADD CONSTRAINT project_recovery_operations_phase_check CHECK(phase IN ('prepared','target-ready','retire-approved','retiring','retreat','old-fenced','switching','published','cancelled','externally-fenced','disaster-ready'));
CREATE OR REPLACE FUNCTION harness.project_recovery_owner(org uuid,project uuid,runtime uuid,old_node uuid,old_volume uuid,old_epoch bigint,next_node uuid,next_volume uuid,next_epoch bigint)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT FROM harness.project_recovery_operations r WHERE r.id::text=current_setting('hgw.recovery_operation',true)
 AND (r.organization_id,r.project_id,r.runtime_id,r.source_node_id,r.source_volume_id,r.source_epoch,r.target_node_id,r.target_volume_id,r.target_epoch)
   =(org,project,runtime,old_node,old_volume,old_epoch,next_node,next_volume,next_epoch)
 AND r.phase='switching' AND r.target_verified_at IS NOT NULL AND (
   r.recovery_mode='planned' AND r.old_fenced_at IS NOT NULL AND r.stopped_generation>0 AND r.stop_operation_id IS NOT NULL AND r.source_files_digest=r.target_files_digest AND r.source_schedule_digest=r.target_schedule_digest
   OR r.recovery_mode='disaster' AND r.source_files_digest IS NULL AND r.source_schedule_digest IS NULL AND EXISTS(
    SELECT FROM harness.project_recovery_isolations a JOIN harness.node_recovery_quarantines q ON q.organization_id=a.organization_id AND q.node_id=a.source_node_id
    JOIN harness.project_recovery_execution_holds h ON h.operation_id=a.operation_id
    WHERE a.operation_id=r.id AND a.organization_id=r.organization_id AND a.source_node_id=r.source_node_id AND a.source_epoch=r.source_epoch AND a.point_id=r.point_id)))
$$;

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
        AND harness.project_recovery_owner(r.organization_id,r.project_id,r.runtime_id,r.source_node_id,r.source_volume_id,r.source_epoch,r.target_node_id,r.target_volume_id,r.target_epoch)) THEN
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
