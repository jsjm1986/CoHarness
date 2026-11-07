-- Per-node resident steward projects.
--
-- A project owns at most one runtime instance organization-wide
-- (instances_organization_project_key), so resident steward runtimes on
-- several nodes require one steward project per node. Each steward project
-- binds to its home node through steward_node_id; the former organization-wide
-- singleton becomes a per-node singleton. Existing steward projects adopt the
-- node their assigned runtime already runs on, and mounts on other nodes are
-- removed because a bound steward project must never materialize elsewhere.
ALTER TABLE harness.projects ADD COLUMN steward_node_id uuid;
UPDATE harness.projects p SET steward_node_id=i.assigned_node_id
  FROM harness.instances i
  WHERE i.organization_id=p.organization_id AND i.project_id=p.id
    AND p.kind='steward' AND p.steward_node_id IS NULL;
-- A steward project seeded without a runtime assignment falls back to the node
-- of its active mount.
UPDATE harness.projects p SET steward_node_id=(
    SELECT pm.node_id FROM harness.project_mounts pm
    WHERE pm.organization_id=p.organization_id AND pm.project_id=p.id
      AND pm.status='active' ORDER BY pm.node_id LIMIT 1)
  WHERE p.kind='steward' AND p.steward_node_id IS NULL;
-- A steward project with neither a runtime assignment nor an active mount has
-- no legitimate home node; archive it so the binding CHECK admits the row and
-- per-node seeding can replace it.
UPDATE harness.projects SET status='archived',updated_at=now(),version=version+1
  WHERE kind='steward' AND steward_node_id IS NULL AND status='active';
DELETE FROM harness.project_mounts pm
  USING harness.projects p
  WHERE p.organization_id=pm.organization_id AND p.id=pm.project_id
    AND p.kind='steward' AND p.steward_node_id IS NOT NULL
    AND pm.node_id<>p.steward_node_id;
ALTER TABLE harness.projects ADD CONSTRAINT projects_steward_node_binding
  CHECK ((kind='steward' AND (steward_node_id IS NOT NULL OR status<>'active'))
      OR (kind<>'steward' AND steward_node_id IS NULL));
ALTER TABLE harness.projects ADD CONSTRAINT projects_steward_node_fkey
  FOREIGN KEY (steward_node_id, organization_id)
  REFERENCES harness.compute_nodes(id, organization_id);
DROP INDEX harness.projects_steward_singleton;
CREATE UNIQUE INDEX projects_steward_per_node
  ON harness.projects(organization_id, steward_node_id)
  WHERE kind='steward';
-- Uniform per-node naming keeps the organization-wide project-name unique key
-- satisfiable and shows the owning node to administrators. Renaming an active
-- project under an organization name policy would require name claims for the
-- new logical revision (require_project_name_claims), which a migration cannot
-- produce; those organizations keep the existing unique name until reindexing
-- claims it.
UPDATE harness.projects p SET name=p.name||'·'||cn.name
  FROM harness.compute_nodes cn
  WHERE cn.id=p.steward_node_id AND p.kind='steward'
    AND p.name NOT LIKE '%·%'
    AND NOT EXISTS (SELECT FROM harness.project_name_policies np
      WHERE np.organization_id=p.organization_id);
