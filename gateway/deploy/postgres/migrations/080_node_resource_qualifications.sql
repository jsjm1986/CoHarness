CREATE FUNCTION harness.project_node_id(organization uuid,project uuid)
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT assigned_node_id FROM harness.instances WHERE organization_id=organization AND project_id=project;
$$;

CREATE FUNCTION harness.capture_node_resource_qualification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  policy record := COALESCE(NEW,OLD);
  public_id bigint;
  subject jsonb;
BEGIN
  IF TG_OP='UPDATE' AND OLD.enabled=NEW.enabled AND OLD.node_id IS NOT DISTINCT FROM NEW.node_id THEN RETURN NEW; END IF;
  IF policy.node_id IS NULL THEN RETURN COALESCE(NEW,OLD); END IF;
  IF policy.user_id IS NOT NULL THEN
    SELECT u.public_id INTO public_id FROM harness.users u WHERE u.id=policy.user_id AND u.organization_id=policy.organization_id;
    subject := jsonb_build_object('userId',public_id,'nodeId',policy.node_id);
  ELSE
    SELECT p.public_id INTO public_id FROM harness.projects p WHERE p.id=policy.project_id AND p.organization_id=policy.organization_id;
    subject := jsonb_build_object('projectId',public_id,'nodeId',policy.node_id);
  END IF;
  IF public_id IS NOT NULL THEN PERFORM harness.invalidate_access(policy.organization_id,subject); END IF;
  RETURN COALESCE(NEW,OLD);
END $$;

DO $$
DECLARE lane text; unplaced boolean;
BEGIN
  FOREACH lane IN ARRAY ARRAY['desktop','terminal','ssh','plugin','steward','memory'] LOOP
    EXECUTE format('ALTER TABLE harness.%I ADD COLUMN node_id uuid,
      ADD CONSTRAINT %I FOREIGN KEY (node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id) ON DELETE CASCADE',
      lane || '_access_policies',lane || '_policy_node');
    EXECUTE format('UPDATE harness.%I p SET node_id=i.assigned_node_id FROM harness.instances i
      WHERE i.organization_id=p.organization_id AND (i.user_id=p.user_id OR i.project_id=p.project_id)',lane || '_access_policies');
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM harness.%I policy
      WHERE policy.node_id IS NULL AND policy.enabled AND (EXISTS(SELECT 1 FROM harness.users u
        JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        WHERE u.id=policy.user_id AND u.status=''active'' AND u.deleted_at IS NULL AND m.status=''active'')
        OR EXISTS(SELECT 1 FROM harness.projects p WHERE p.id=policy.project_id AND p.status=''active'')))',
      lane || '_access_policies') INTO unplaced;
    IF unplaced THEN
      RAISE EXCEPTION '% qualification has an active owner without a computer assignment',lane
        USING HINT='Restore the owner instance assignment or disable its unplaced qualification before upgrading.';
    END IF;
    -- Unplaced legacy rows retain their data but never authorize a computer.
    -- All new policy writes must explicitly name the server-owned node.
    EXECUTE format('ALTER TABLE harness.%I ADD CONSTRAINT %I CHECK(node_id IS NOT NULL) NOT VALID',
      lane || '_access_policies',lane || '_policy_node_required');
    EXECUTE format('DROP INDEX harness.%I',lane || '_user_policy');
    EXECUTE format('DROP INDEX IF EXISTS harness.%I',lane || '_project_policy');
    EXECUTE format('CREATE UNIQUE INDEX %I ON harness.%I(organization_id,node_id,user_id) WHERE user_id IS NOT NULL',
      lane || '_user_policy',lane || '_access_policies');
    EXECUTE format('CREATE UNIQUE INDEX %I ON harness.%I(organization_id,node_id,project_id) WHERE project_id IS NOT NULL',
      lane || '_project_policy',lane || '_access_policies');
    EXECUTE format('DROP TRIGGER %I ON harness.%I',lane || '_access_changes',lane || '_access_policies');
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON harness.%I
      FOR EACH ROW EXECUTE FUNCTION harness.capture_node_resource_qualification()',lane || '_access_changes',lane || '_access_policies');
  END LOOP;
END $$;
