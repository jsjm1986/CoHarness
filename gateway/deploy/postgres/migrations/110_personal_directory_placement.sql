-- A promoted personal directory must remain on its publisher, including while the node is offline.
CREATE TABLE harness.personal_directory_placement (
  runtime_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  node_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
  FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
  FOREIGN KEY(owner_id,organization_id) REFERENCES harness.users(id,organization_id)
);
CREATE FUNCTION harness.guard_personal_directory_placement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM harness.runtime_environments e WHERE e.id=NEW.runtime_id AND e.organization_id=NEW.organization_id
    AND e.owner_kind='user' AND e.owner_id=NEW.owner_id AND e.node_id=NEW.node_id AND e.retired_at IS NULL)
  THEN RAISE EXCEPTION 'Personal directory placement requires the current account allocation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER personal_directory_owner BEFORE INSERT OR UPDATE ON harness.personal_directory_placement
FOR EACH ROW EXECUTE FUNCTION harness.guard_personal_directory_placement();
CREATE FUNCTION harness.reject_promoted_workspace_publication() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM harness.personal_directory_placement p WHERE p.organization_id=NEW.organization_id AND p.runtime_id=NEW.runtime_id)
    OR EXISTS(SELECT 1 FROM harness.project_content_placement b WHERE b.organization_id=NEW.organization_id AND b.runtime_id=NEW.runtime_id)
  THEN RAISE EXCEPTION 'Workspace directory is owned by its computer'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER personal_directory_local_only BEFORE INSERT OR UPDATE ON harness.runtime_workspace_catalog
FOR EACH ROW EXECUTE FUNCTION harness.reject_promoted_workspace_publication();
