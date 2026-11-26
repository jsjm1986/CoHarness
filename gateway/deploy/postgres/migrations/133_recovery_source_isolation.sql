-- One immutable physical-isolation receipt can protect project or personal writers.
CREATE TABLE harness.recovery_source_isolations (
 operation_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 scope_kind text NOT NULL CHECK(scope_kind IN ('project','personal')),
 scope_id uuid NOT NULL,
 runtime_id uuid NOT NULL,
 source_node_id uuid NOT NULL,
 source_generation bigint NOT NULL CHECK(source_generation>0),
 source_epoch bigint NOT NULL CHECK(source_epoch>0),
 point_id uuid NOT NULL,
 policy_revision integer NOT NULL CHECK(policy_revision>0),
 method text NOT NULL CHECK(method IN ('power-off','network-isolation')),
 evidence_reference text NOT NULL CHECK(length(evidence_reference) BETWEEN 1 AND 512),
 confirmed_by uuid NOT NULL,
 confirmed_at timestamptz NOT NULL,
 acknowledge_data_loss boolean NOT NULL CHECK(acknowledge_data_loss),
 project_isolation_id uuid REFERENCES harness.project_recovery_isolations(operation_id),
 CHECK((scope_kind='project' AND project_isolation_id IS NOT NULL AND project_isolation_id=operation_id) OR (scope_kind='personal' AND project_isolation_id IS NULL)),
 UNIQUE(operation_id,organization_id,source_node_id),
 FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
 FOREIGN KEY(organization_id,source_node_id) REFERENCES harness.compute_nodes(organization_id,id),
 FOREIGN KEY(confirmed_by,organization_id) REFERENCES harness.users(id,organization_id)
);
INSERT INTO harness.recovery_source_isolations
 SELECT a.operation_id,a.organization_id,'project',r.project_id,r.runtime_id,a.source_node_id,a.source_generation,a.source_epoch,
 a.point_id,a.policy_revision,a.method,a.evidence_reference,a.confirmed_by,a.confirmed_at,a.acknowledge_data_loss,a.operation_id
 FROM harness.project_recovery_isolations a JOIN harness.project_recovery_operations r
 ON r.id=a.operation_id AND r.organization_id=a.organization_id AND r.source_node_id=a.source_node_id
 AND r.source_epoch=a.source_epoch AND r.point_id=a.point_id;
DO $$ BEGIN
 IF (SELECT count(*) FROM harness.recovery_source_isolations)<>(SELECT count(*) FROM harness.project_recovery_isolations)
 THEN RAISE EXCEPTION 'Existing isolation evidence cannot be attributed to its original project'; END IF;
END $$;

CREATE FUNCTION harness.validate_recovery_source_isolation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
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
  RAISE EXCEPTION 'Personal physical isolation requires the personal takeover schema' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_recovery_source_isolation BEFORE INSERT ON harness.recovery_source_isolations
 FOR EACH ROW EXECUTE FUNCTION harness.validate_recovery_source_isolation();
CREATE TRIGGER immutable_recovery_source_isolation BEFORE UPDATE OR DELETE ON harness.recovery_source_isolations
 FOR EACH ROW EXECUTE FUNCTION harness.preserve_disaster_receipt();

CREATE FUNCTION harness.mirror_project_source_isolation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO harness.recovery_source_isolations
 SELECT NEW.operation_id,NEW.organization_id,'project',r.project_id,r.runtime_id,NEW.source_node_id,NEW.source_generation,NEW.source_epoch,
 NEW.point_id,NEW.policy_revision,NEW.method,NEW.evidence_reference,NEW.confirmed_by,NEW.confirmed_at,NEW.acknowledge_data_loss,NEW.operation_id
 FROM harness.project_recovery_operations r WHERE r.id=NEW.operation_id AND r.organization_id=NEW.organization_id;
 RETURN NEW;
END $$;
CREATE TRIGGER mirror_project_source_isolation AFTER INSERT ON harness.project_recovery_isolations
 FOR EACH ROW EXECUTE FUNCTION harness.mirror_project_source_isolation();
ALTER TABLE harness.node_recovery_quarantines DROP CONSTRAINT node_recovery_quarantines_operation_id_fkey;
ALTER TABLE harness.node_recovery_quarantines ADD CONSTRAINT node_recovery_quarantines_operation_id_fkey
 FOREIGN KEY(operation_id,organization_id,node_id) REFERENCES harness.recovery_source_isolations(operation_id,organization_id,source_node_id);

CREATE OR REPLACE FUNCTION harness.node_physically_isolated(organization uuid,node uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT FROM harness.compute_nodes n
   JOIN harness.node_recovery_quarantines q ON q.organization_id=n.organization_id AND q.node_id=n.id
   JOIN harness.recovery_source_isolations a ON a.operation_id=q.operation_id
     AND a.organization_id=q.organization_id AND a.source_node_id=q.node_id
   WHERE n.organization_id=organization AND n.id=node AND n.status='offline' AND a.acknowledge_data_loss
     AND NOT EXISTS(SELECT FROM harness.instances i WHERE i.organization_id=n.organization_id AND i.assigned_node_id=n.id
       AND (i.desired_state<>'stopped' OR i.runtime_token_hash IS NOT NULL))
     AND NOT EXISTS(SELECT FROM harness.node_agents agent WHERE agent.organization_id=n.organization_id AND agent.node_id=n.id
       AND (agent.credential_hash IS NOT NULL OR agent.revoked_at IS NULL OR agent.connection_id IS NOT NULL OR agent.lease_expires_at IS NOT NULL))
     AND NOT EXISTS(SELECT FROM harness.node_agent_enrollments e WHERE e.organization_id=n.organization_id AND e.node_id=n.id AND e.consumed_at IS NULL))
$$;
