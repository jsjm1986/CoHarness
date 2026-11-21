ALTER TABLE harness.node_agent_enrollments
  DROP CONSTRAINT node_agent_enrollments_node_id_organization_id_fkey,
  ALTER COLUMN node_id DROP NOT NULL,
  ADD FOREIGN KEY (node_id, organization_id)
    REFERENCES harness.node_agents(node_id, organization_id) ON DELETE SET NULL (node_id);
