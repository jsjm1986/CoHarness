ALTER TABLE harness.node_agent_enrollments
  DROP CONSTRAINT node_agent_enrollments_created_by_organization_id_fkey;

COMMENT ON COLUMN harness.node_agent_enrollments.created_by IS
  'Historical issuer UUID, verified by the issuing service in this organization. A restored application snapshot may omit that user.';
