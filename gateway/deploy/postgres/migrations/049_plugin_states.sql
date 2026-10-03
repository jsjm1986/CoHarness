-- Plugin desired state is the durable source of truth for profile enablement and bundle selection.
CREATE TABLE harness.plugin_states (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  user_id uuid,
  project_id uuid,
  entries jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(entries) = 'array'),
  bundles jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(bundles) = 'array'),
  revision bigint NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NOT NULL)::integer + (project_id IS NOT NULL)::integer = 1),
  FOREIGN KEY (organization_id,user_id) REFERENCES harness.users(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id,project_id) REFERENCES harness.projects(organization_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX plugin_user_state ON harness.plugin_states(organization_id,user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX plugin_project_state ON harness.plugin_states(organization_id,project_id) WHERE project_id IS NOT NULL;
