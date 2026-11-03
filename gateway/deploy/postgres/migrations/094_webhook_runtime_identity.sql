ALTER TABLE harness.webhook_endpoints ADD COLUMN runtime_id uuid, ADD COLUMN node_id uuid;
WITH candidates AS (
  SELECT endpoint.id,array_agg(instance.runtime_id) runtimes,array_agg(instance.assigned_node_id) nodes
  FROM harness.webhook_endpoints endpoint JOIN harness.instances instance ON instance.organization_id=endpoint.organization_id
  LEFT JOIN harness.users account ON account.organization_id=instance.organization_id AND account.id=instance.user_id
  LEFT JOIN harness.projects project ON project.organization_id=instance.organization_id AND project.id=instance.project_id
  WHERE endpoint.runtime_kind=CASE WHEN instance.user_id IS NULL THEN 'project' ELSE 'user' END
    AND endpoint.runtime_public_id=COALESCE(account.public_id,project.public_id) GROUP BY endpoint.id HAVING count(*)=1
) UPDATE harness.webhook_endpoints endpoint SET runtime_id=candidates.runtimes[1],node_id=candidates.nodes[1]
  FROM candidates WHERE candidates.id=endpoint.id;
UPDATE harness.webhook_endpoints SET enabled=false WHERE runtime_id IS NULL;
ALTER TABLE harness.webhook_endpoints
  ADD FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
  ADD FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
  ADD CONSTRAINT enabled_webhook_runtime CHECK(NOT enabled OR runtime_id IS NOT NULL AND node_id IS NOT NULL);

CREATE FUNCTION harness.validate_webhook_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.runtime_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM harness.runtime_environments environment
    LEFT JOIN harness.users account ON environment.owner_kind='user' AND account.organization_id=environment.organization_id AND account.id=environment.owner_id
    LEFT JOIN harness.projects project ON environment.owner_kind='project' AND project.organization_id=environment.organization_id AND project.id=environment.owner_id
    WHERE environment.organization_id=NEW.organization_id AND environment.id=NEW.runtime_id AND environment.node_id=NEW.node_id
      AND environment.owner_kind=NEW.runtime_kind AND COALESCE(account.public_id,project.public_id)=NEW.runtime_public_id) THEN
    RAISE EXCEPTION 'Webhook belongs to another Runtime or computer' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_webhook_runtime BEFORE INSERT OR UPDATE ON harness.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION harness.validate_webhook_runtime();

ALTER TABLE harness.webhook_delivery_receipts ADD COLUMN runtime_id uuid;
UPDATE harness.webhook_delivery_receipts receipt SET runtime_id=endpoint.runtime_id FROM harness.webhook_endpoints endpoint
  WHERE endpoint.organization_id=receipt.organization_id AND endpoint.id=receipt.endpoint_id
    AND endpoint.node_id=receipt.node_id AND endpoint.runtime_kind=receipt.runtime_kind AND endpoint.runtime_public_id=receipt.runtime_public_id;
ALTER TABLE harness.webhook_delivery_receipts ADD FOREIGN KEY(runtime_id,organization_id)
  REFERENCES harness.runtime_environments(id,organization_id);
