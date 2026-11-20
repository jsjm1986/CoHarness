-- The encrypted repository receiver and the replacement writer are independent immutable identities.
ALTER TABLE harness.project_recovery_operations ADD COLUMN repository_node_id uuid;
ALTER TABLE harness.personal_recovery_operations ADD COLUMN repository_node_id uuid;
ALTER TABLE harness.project_recovery_operations DISABLE TRIGGER keep_project_recovery_evidence;
ALTER TABLE harness.personal_recovery_operations DISABLE TRIGGER keep_personal_recovery_evidence;
UPDATE harness.project_recovery_operations r SET repository_node_id=p.target_node_id FROM harness.peer_backup_policies p WHERE p.id=r.policy_id;
UPDATE harness.personal_recovery_operations r SET repository_node_id=p.target_node_id FROM harness.peer_backup_policies p WHERE p.id=r.policy_id;
ALTER TABLE harness.project_recovery_operations ALTER COLUMN repository_node_id SET NOT NULL;
ALTER TABLE harness.personal_recovery_operations ALTER COLUMN repository_node_id SET NOT NULL;
ALTER TABLE harness.project_recovery_operations ADD FOREIGN KEY(repository_node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id);
ALTER TABLE harness.personal_recovery_operations ADD FOREIGN KEY(repository_node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id);
ALTER TABLE harness.project_recovery_operations DROP CONSTRAINT project_recovery_operations_phase_check;
ALTER TABLE harness.project_recovery_operations ADD CONSTRAINT project_recovery_operations_phase_check CHECK(phase IN
 ('preparing','prepared','target-ready','retire-approved','retiring','retreat','old-fenced','switching','published','cancelled','externally-fenced','disaster-ready'));
UPDATE harness.project_recovery_operations SET phase='preparing' WHERE recovery_mode='disaster' AND phase='prepared' AND target_verified_at IS NULL;
ALTER TABLE harness.project_recovery_operations ENABLE TRIGGER keep_project_recovery_evidence;
ALTER TABLE harness.personal_recovery_operations ENABLE TRIGGER keep_personal_recovery_evidence;

CREATE TABLE harness.peer_recovery_node_protocols (
 organization_id uuid NOT NULL,node_id uuid NOT NULL,protocol integer NOT NULL CHECK(protocol=2),
 project_ready boolean NOT NULL DEFAULT false,personal_ready boolean NOT NULL DEFAULT false,
 topology_revision bigint NOT NULL,write_epoch bigint NOT NULL,connection_epoch bigint,node_credential_hash bytea,expires_at timestamptz NOT NULL,
 PRIMARY KEY(organization_id,node_id),FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id)
);
CREATE FUNCTION harness.peer_recovery_destination_supported(org uuid,node uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT FROM harness.peer_recovery_node_protocols proof JOIN harness.deployment_topology t ON t.organization_id=proof.organization_id
 JOIN harness.cluster_control c ON c.organization_id=t.organization_id JOIN harness.compute_nodes n ON n.organization_id=t.organization_id AND n.id=proof.node_id
 LEFT JOIN harness.node_agents a ON a.organization_id=n.organization_id AND a.node_id=n.id
 WHERE proof.organization_id=org AND proof.node_id=node AND proof.protocol=2 AND proof.expires_at>clock_timestamp()
   AND proof.topology_revision=t.revision AND proof.write_epoch=c.write_epoch AND t.enabled AND c.mode='serving' AND n.status='active'
   AND NOT EXISTS(SELECT FROM harness.node_recovery_quarantines q WHERE q.organization_id=org AND q.node_id=node)
   AND (t.primary_node_id=node AND proof.connection_epoch IS NULL OR a.attachment_state='managed' AND a.revoked_at IS NULL
     AND a.connection_id IS NOT NULL AND a.lease_expires_at>clock_timestamp() AND a.credential_hash=proof.node_credential_hash
     AND a.connection_epoch=proof.connection_epoch))
$$;
CREATE FUNCTION harness.peer_recovery_worker_supported(org uuid,node uuid,scope text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT harness.peer_recovery_destination_supported(org,node) AND EXISTS(
   SELECT FROM harness.peer_recovery_node_protocols proof WHERE proof.organization_id=org AND proof.node_id=node
     AND CASE scope WHEN 'project' THEN proof.project_ready WHEN 'personal' THEN proof.personal_ready ELSE false END)
$$;

CREATE TABLE harness.peer_backup_recovery_access (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,policy_id uuid NOT NULL,policy_revision integer NOT NULL CHECK(policy_revision>0),point_id uuid NOT NULL,
 repository_node_id uuid NOT NULL,reader_node_id uuid NOT NULL,credential_hash text NOT NULL UNIQUE CHECK(credential_hash~'^[a-f0-9]{64}$'),
 topology_revision bigint NOT NULL,write_epoch bigint NOT NULL,connection_epoch bigint,node_credential_hash bytea,
 approved_by uuid NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(repository_node_id<>reader_node_id),CHECK((connection_epoch IS NULL)=(node_credential_hash IS NULL)),
 FOREIGN KEY(policy_id,organization_id) REFERENCES harness.peer_backup_policies(id,organization_id),
 FOREIGN KEY(point_id) REFERENCES harness.peer_backup_points(id),
 FOREIGN KEY(repository_node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
 FOREIGN KEY(reader_node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
 FOREIGN KEY(approved_by,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE FUNCTION harness.keep_peer_recovery_access() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR to_jsonb(OLD)-'revoked_at'<>to_jsonb(NEW)-'revoked_at' OR OLD.revoked_at IS NOT NULL
 THEN RAISE EXCEPTION 'Recovery read approval is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER keep_peer_recovery_access BEFORE UPDATE OR DELETE ON harness.peer_backup_recovery_access
 FOR EACH ROW EXECUTE FUNCTION harness.keep_peer_recovery_access();
CREATE FUNCTION harness.bind_recovery_repository() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE receiver uuid;
BEGIN
 SELECT p.target_node_id INTO receiver FROM harness.peer_backup_policies p JOIN harness.peer_backup_points q ON q.policy_id=p.id
   WHERE p.id=NEW.policy_id AND p.organization_id=NEW.organization_id AND q.id=NEW.point_id;
 IF receiver IS NULL OR NEW.repository_node_id IS NOT NULL AND NEW.repository_node_id<>receiver
 THEN RAISE EXCEPTION 'Recovery repository does not match its immutable point' USING ERRCODE='23514'; END IF;
 NEW.repository_node_id=receiver;
 IF NEW.target_node_id<>receiver AND (NOT harness.peer_recovery_destination_supported(NEW.organization_id,receiver) OR NOT harness.peer_recovery_worker_supported(NEW.organization_id,NEW.target_node_id,CASE TG_TABLE_NAME WHEN 'project_recovery_operations' THEN 'project' ELSE 'personal' END)) THEN RAISE EXCEPTION 'Recovery destination protocol is unavailable' USING ERRCODE='23514'; END IF;
 IF NEW.phase IN('preparing','prepared') AND NOT harness.peer_recovery_worker_supported(NEW.organization_id,NEW.target_node_id,
   CASE TG_TABLE_NAME WHEN 'project_recovery_operations' THEN 'project' ELSE 'personal' END)
 THEN RAISE EXCEPTION 'Recovery preparation worker is unavailable' USING ERRCODE='23514'; END IF;
 IF NEW.source_node_id=NEW.target_node_id THEN RAISE EXCEPTION 'Replacement must be independent'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bind_project_recovery_repository BEFORE INSERT ON harness.project_recovery_operations
 FOR EACH ROW EXECUTE FUNCTION harness.bind_recovery_repository();
CREATE TRIGGER bind_personal_recovery_repository BEFORE INSERT ON harness.personal_recovery_operations
 FOR EACH ROW EXECUTE FUNCTION harness.bind_recovery_repository();

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
    OR NOT ((OLD.phase,NEW.phase) IN (('preparing','prepared'),('preparing','cancelled'),('prepared','target-ready'),('prepared','cancelled'),('target-ready','cancelled'),
      ('target-ready','retire-approved'),('retire-approved','retiring'),('retire-approved','cancelled'),('retiring','retreat'),('retiring','old-fenced'),
      ('retreat','cancelled'),('retreat','old-fenced'),('old-fenced','switching'),('switching','published'),('prepared','externally-fenced'),('externally-fenced','disaster-ready'),('disaster-ready','switching')))
    THEN RAISE EXCEPTION 'Invalid project recovery transition'; END IF;
  IF NEW.phase='retire-approved' AND (NEW.retirement_approved_at IS NULL OR NEW.retirement_approved_by IS NULL)
    OR (NEW.phase IN ('target-ready','disaster-ready') OR NEW.recovery_mode='disaster' AND NEW.phase IN ('prepared','externally-fenced')) AND (NEW.target_verified_at IS NULL OR NEW.target_schedule_digest IS NULL OR NEW.target_files_digest IS NULL OR NEW.target_port_base IS NULL)
    OR NEW.phase='old-fenced' AND (NEW.old_fenced_at IS NULL OR NEW.stopped_generation IS NULL OR NEW.stop_operation_id IS NULL
      OR NEW.source_schedule_digest IS DISTINCT FROM NEW.target_schedule_digest OR NEW.source_files_digest IS DISTINCT FROM NEW.target_files_digest)
    OR NEW.phase='published' AND NEW.published_at IS NULL THEN RAISE EXCEPTION 'Incomplete project recovery evidence'; END IF;
  IF NEW.recovery_mode='disaster' AND (NEW.source_schedule_digest IS NOT NULL OR NEW.source_files_digest IS NOT NULL OR NEW.old_fenced_at IS NOT NULL OR NEW.stopped_generation IS NOT NULL OR NEW.stop_operation_id IS NOT NULL)
    THEN RAISE EXCEPTION 'External isolation cannot fabricate source evidence'; END IF;
  IF NEW.phase IN ('externally-fenced','disaster-ready') AND (NEW.recovery_mode<>'disaster' OR NOT EXISTS(
    SELECT FROM harness.project_recovery_isolations a JOIN harness.node_recovery_quarantines q ON q.organization_id=a.organization_id AND q.node_id=a.source_node_id
    WHERE a.operation_id=NEW.id AND a.organization_id=NEW.organization_id AND a.source_node_id=NEW.source_node_id
    AND a.source_epoch=NEW.source_epoch AND a.point_id=NEW.point_id)) THEN RAISE EXCEPTION 'External isolation evidence is missing'; END IF;
  IF NEW.recovery_mode='planned' AND NEW.phase IN ('preparing','externally-fenced','disaster-ready') OR NEW.recovery_mode='disaster' AND NEW.phase IN ('target-ready','retire-approved','retiring','retreat','old-fenced')
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
