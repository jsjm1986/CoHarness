DROP INDEX harness.instances_organization_user_key;
DROP INDEX harness.runtime_environment_personal_node;

CREATE INDEX instances_personal_allocations ON harness.instances(organization_id,user_id,assigned_node_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX runtime_environment_personal_node_page ON harness.runtime_environments(organization_id,owner_id,node_id,id)
  WHERE owner_kind='user' AND retired_at IS NULL;
