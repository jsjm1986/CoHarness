-- Document bodies, catalog paths, transfer item names and file journals are owned by the serving node.
CREATE TABLE harness.document_scope_placement (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  node_id uuid NOT NULL, scope_kind text NOT NULL CHECK(scope_kind IN ('personal','project')),
  scope_id uuid NOT NULL, root_id uuid NOT NULL, volume_id uuid NOT NULL,
  writer_epoch bigint NOT NULL CHECK(writer_epoch>0), publication_revision bigint NOT NULL CHECK(publication_revision>=0),
  project_runtime_id uuid,
  PRIMARY KEY(organization_id,node_id,scope_kind,scope_id), UNIQUE(organization_id,root_id),
  FOREIGN KEY(organization_id,node_id,volume_id) REFERENCES harness.node_content_volumes(organization_id,node_id,volume_id),
  FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
  FOREIGN KEY(project_runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
  CHECK ((scope_kind='project')=(project_runtime_id IS NOT NULL))
);
CREATE FUNCTION harness.check_document_scope_placement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Document scope publication is immutable'; END IF;
  IF NEW.scope_kind='personal' AND NOT EXISTS(SELECT FROM harness.users u WHERE u.organization_id=NEW.organization_id AND u.id=NEW.scope_id)
    OR NEW.scope_kind='project' AND NOT EXISTS(SELECT FROM harness.runtime_environments r
       WHERE r.organization_id=NEW.organization_id AND r.node_id=NEW.node_id AND r.owner_kind='project'
         AND r.owner_id=NEW.scope_id AND r.id=NEW.project_runtime_id AND r.retired_at IS NULL)
  THEN RAISE EXCEPTION 'Document scope owner does not match its assigned node'; END IF;
  IF EXISTS(SELECT FROM harness.document_catalog d WHERE d.organization_id=NEW.organization_id AND d.node_id=NEW.node_id
      AND d.scope_kind=NEW.scope_kind AND coalesce(d.scope_user_id,d.scope_project_id)=NEW.scope_id)
    OR EXISTS(SELECT FROM harness.document_projection_checkpoints c WHERE c.organization_id=NEW.organization_id AND c.node_id=NEW.node_id
      AND c.scope_kind=NEW.scope_kind AND coalesce(c.scope_user_id,c.scope_project_id)=NEW.scope_id)
    OR EXISTS(SELECT FROM harness.document_operations e WHERE e.organization_id=NEW.organization_id AND
      ((NEW.scope_kind='project' AND NEW.scope_id IN (e.source_project_id,e.target_project_id)) OR
       (NEW.scope_kind='personal' AND NEW.scope_id IN (e.source_user_id,e.target_user_id))))
  THEN RAISE EXCEPTION 'Document scope still has shared catalog or transfer history'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_scope_placement_immutable BEFORE INSERT OR UPDATE OR DELETE ON harness.document_scope_placement
  FOR EACH ROW EXECUTE FUNCTION harness.check_document_scope_placement();
CREATE FUNCTION harness.reject_published_document_content() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT FROM harness.document_scope_placement p WHERE p.organization_id=NEW.organization_id
      AND p.node_id=NEW.node_id AND p.scope_kind=NEW.scope_kind AND p.scope_id=coalesce(NEW.scope_user_id,NEW.scope_project_id))
  THEN RAISE EXCEPTION 'Document catalog belongs to its owning computer'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_catalog_physical_root BEFORE INSERT OR UPDATE ON harness.document_catalog
  FOR EACH ROW EXECUTE FUNCTION harness.reject_published_document_content();
CREATE TRIGGER document_checkpoint_physical_root BEFORE INSERT OR UPDATE ON harness.document_projection_checkpoints
  FOR EACH ROW EXECUTE FUNCTION harness.reject_published_document_content();
CREATE FUNCTION harness.check_document_project_volume() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.scope_kind='project' AND NOT EXISTS(SELECT FROM harness.project_content_placement p WHERE p.organization_id=NEW.organization_id
       AND p.project_id=NEW.scope_id AND p.node_id=NEW.node_id AND p.volume_id=NEW.volume_id AND p.runtime_id=NEW.project_runtime_id
       AND p.writer_epoch=NEW.writer_epoch) THEN RAISE EXCEPTION 'Project documents require the published project volume'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER document_project_volume AFTER INSERT ON harness.document_scope_placement DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION harness.check_document_project_volume();
CREATE FUNCTION harness.reject_published_document_transfer() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT FROM harness.document_scope_placement p WHERE p.organization_id=NEW.organization_id AND
      ((p.scope_kind='project' AND p.scope_id IN (NEW.source_project_id,NEW.target_project_id)) OR
       (p.scope_kind='personal' AND p.scope_id IN (NEW.source_user_id,NEW.target_user_id) AND p.node_id=NEW.node_id)))
  THEN RAISE EXCEPTION 'Document transfer belongs to its owning computer'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_transfers_physical_root BEFORE INSERT OR UPDATE ON harness.document_operations
  FOR EACH ROW EXECUTE FUNCTION harness.reject_published_document_transfer();
-- Serialize a legacy commit with first publication, including transactions whose MVCC snapshot predates the handoff.
CREATE TABLE harness.document_scope_writers (
  organization_id uuid NOT NULL, node_id uuid NOT NULL, scope_kind text NOT NULL, scope_id uuid NOT NULL,
  published boolean NOT NULL DEFAULT false, PRIMARY KEY(organization_id,node_id,scope_kind,scope_id),
  FOREIGN KEY(organization_id) REFERENCES harness.organizations(id) ON DELETE CASCADE
);
CREATE FUNCTION harness.lock_document_scope_writer(org uuid,node uuid,kind text,owner uuid,publish boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE current_published boolean;
BEGIN
  IF org IS NULL OR node IS NULL OR owner IS NULL OR kind IS NULL THEN RETURN; END IF;
  IF publish THEN
    INSERT INTO harness.document_scope_writers(organization_id,node_id,scope_kind,scope_id,published)
      VALUES(org,node,kind,owner,true) ON CONFLICT(organization_id,node_id,scope_kind,scope_id) DO UPDATE SET published=true;
    RETURN;
  END IF;
  SELECT w.published INTO current_published FROM harness.document_scope_writers w
    WHERE w.organization_id=org AND w.node_id=node AND w.scope_kind=kind AND w.scope_id=owner FOR SHARE;
  IF NOT FOUND THEN
    INSERT INTO harness.document_scope_writers(organization_id,node_id,scope_kind,scope_id,published)
      VALUES(org,node,kind,owner,false) ON CONFLICT DO NOTHING;
    SELECT w.published INTO STRICT current_published FROM harness.document_scope_writers w
      WHERE w.organization_id=org AND w.node_id=node AND w.scope_kind=kind AND w.scope_id=owner FOR SHARE;
  END IF;
  IF current_published THEN RAISE EXCEPTION 'Document scope writer has moved to its computer'; END IF;
END $$;
CREATE FUNCTION harness.serialize_document_scope_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='document_scope_placement' THEN
    PERFORM harness.lock_document_scope_writer(NEW.organization_id,NEW.node_id,NEW.scope_kind,NEW.scope_id,true);
  ELSIF TG_TABLE_NAME='document_operations' THEN
    PERFORM harness.lock_document_scope_writer(NEW.organization_id,NEW.node_id,NEW.source_scope_kind,coalesce(NEW.source_user_id,NEW.source_project_id),false);
    PERFORM harness.lock_document_scope_writer(NEW.organization_id,NEW.node_id,NEW.target_scope_kind,coalesce(NEW.target_user_id,NEW.target_project_id),false);
  ELSE
    PERFORM harness.lock_document_scope_writer(NEW.organization_id,NEW.node_id,NEW.scope_kind,coalesce(NEW.scope_user_id,NEW.scope_project_id),false);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_00_catalog_writer BEFORE INSERT OR UPDATE ON harness.document_catalog FOR EACH ROW EXECUTE FUNCTION harness.serialize_document_scope_change();
CREATE TRIGGER document_00_checkpoint_writer BEFORE INSERT OR UPDATE ON harness.document_projection_checkpoints FOR EACH ROW EXECUTE FUNCTION harness.serialize_document_scope_change();
CREATE TRIGGER document_00_transfer_writer BEFORE INSERT OR UPDATE ON harness.document_operations FOR EACH ROW EXECUTE FUNCTION harness.serialize_document_scope_change();
CREATE TRIGGER document_00_publication_writer BEFORE INSERT ON harness.document_scope_placement FOR EACH ROW EXECUTE FUNCTION harness.serialize_document_scope_change();
-- Transport receipts carry only opaque coordinates. Names, errors and document versions are resolved on the owning node.
CREATE TABLE harness.document_transfer_delivery (
  organization_id uuid NOT NULL, node_id uuid NOT NULL, root_id uuid NOT NULL,
  operation_id uuid NOT NULL, direction text NOT NULL CHECK(direction IN ('source','target')),
  item_id text NOT NULL CHECK(item_id ~ '^[0-9a-f]{64}$'), counterpart_node_id uuid NOT NULL,
  actor_id uuid NOT NULL, incarnation_id uuid, succeeded boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz, claim uuid, retry_at timestamptz NOT NULL DEFAULT now(), last_error text, PRIMARY KEY(root_id,operation_id,direction,item_id,succeeded),
  FOREIGN KEY(organization_id,root_id) REFERENCES harness.document_scope_placement(organization_id,root_id),
  FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
  FOREIGN KEY(counterpart_node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
  FOREIGN KEY(actor_id,organization_id) REFERENCES harness.users(id,organization_id),
  CHECK(NOT succeeded OR incarnation_id IS NOT NULL)
);
CREATE INDEX document_transfer_waiting ON harness.document_transfer_delivery(organization_id,node_id,created_at) WHERE delivered_at IS NULL;
