-- Account identity is global; working directories belong to one computer.
CREATE TABLE harness.node_user_accounts (
  organization_id uuid NOT NULL,
  node_id uuid NOT NULL,
  user_id uuid NOT NULL,
  home_path text NOT NULL CHECK(home_path<>''),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,node_id,user_id),
  FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,organization_id) REFERENCES harness.users(id,organization_id) ON DELETE CASCADE
);
INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path)
  SELECT i.organization_id,i.assigned_node_id,i.user_id,u.home_path FROM harness.instances i
    JOIN harness.users u ON u.organization_id=i.organization_id AND u.id=i.user_id;

ALTER TABLE harness.instances
  ADD COLUMN storage_layout text NOT NULL DEFAULT 'legacy' CHECK(storage_layout IN ('legacy','isolated')),
  ADD CONSTRAINT project_runtime_storage CHECK(project_id IS NULL OR storage_layout='legacy'),
  ADD CONSTRAINT runtime_node_account FOREIGN KEY(organization_id,assigned_node_id,user_id)
    REFERENCES harness.node_user_accounts(organization_id,node_id,user_id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX runtime_legacy_personal_storage ON harness.instances(organization_id,assigned_node_id,user_id)
  WHERE user_id IS NOT NULL AND storage_layout='legacy';

CREATE FUNCTION harness.bind_runtime_storage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.storage_layout IS DISTINCT FROM OLD.storage_layout THEN
    RAISE EXCEPTION 'runtime storage layout is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;
  -- First-computer provisioning retains the account's released working directory.
  INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path)
    SELECT u.organization_id,NEW.assigned_node_id,u.id,u.home_path FROM harness.users u
    WHERE u.organization_id=NEW.organization_id AND u.id=NEW.user_id AND NOT EXISTS(
      SELECT 1 FROM harness.node_user_accounts a WHERE a.organization_id=u.organization_id AND a.user_id=u.id)
    ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM harness.node_user_accounts a WHERE a.organization_id=NEW.organization_id
    AND a.node_id=NEW.assigned_node_id AND a.user_id=NEW.user_id) THEN
    RAISE EXCEPTION 'runtime computer account requires local provisioning' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bind_runtime_storage BEFORE INSERT OR UPDATE ON harness.instances
  FOR EACH ROW EXECUTE FUNCTION harness.bind_runtime_storage();
