-- The retained source is frozen in place. Live directory, lifecycle and audit reads use the published node root.
CREATE TABLE harness.personal_document_imports (
  organization_id uuid NOT NULL,node_id uuid NOT NULL,user_id uuid NOT NULL,root_id uuid PRIMARY KEY,volume_id uuid NOT NULL,
  actor_id uuid NOT NULL,catalog_digest text NOT NULL CHECK(catalog_digest~'^[a-f0-9]{64}$'),physical_digest text NOT NULL CHECK(physical_digest~'^[a-f0-9]{64}$'),
  source_count bigint NOT NULL CHECK(source_count>=0),history_count bigint NOT NULL CHECK(history_count>=0),
  sequence bigint NOT NULL CHECK(sequence>=0),ordinal integer NOT NULL CHECK(ordinal>=0),approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,node_id,user_id),FOREIGN KEY(organization_id,node_id,volume_id) REFERENCES harness.node_content_volumes(organization_id,node_id,volume_id),
  FOREIGN KEY(actor_id,organization_id) REFERENCES harness.users(id,organization_id),
  FOREIGN KEY(user_id,organization_id) REFERENCES harness.users(id,organization_id),
  FOREIGN KEY(organization_id,root_id) REFERENCES harness.document_scope_placement(organization_id,root_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION harness.personal_document_source_digest(org uuid,node uuid,owner uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  WITH docs AS (SELECT * FROM harness.document_catalog d WHERE d.organization_id=org AND d.node_id=node AND d.scope_kind='personal' AND d.scope_user_id=owner),
  entries AS (SELECT 'd:'||d.id AS key,sha256(convert_to(to_jsonb(d)::text,'UTF8')) AS value FROM docs d
    UNION ALL SELECT 'h:'||h.id,sha256(convert_to(to_jsonb(h)::text,'UTF8')) FROM harness.document_history h JOIN docs d ON h.catalog_id=d.id AND h.organization_id=d.organization_id
    UNION ALL SELECT 'c:'||c.root_id,sha256(convert_to(to_jsonb(c)::text,'UTF8')) FROM harness.document_projection_checkpoints c
      WHERE c.organization_id=org AND c.node_id=node AND c.scope_kind='personal' AND c.scope_user_id=owner)
  SELECT encode(sha256(convert_to(coalesce(string_agg(key||encode(value,'hex'),',' ORDER BY key COLLATE "C"),''),'UTF8')),'hex') FROM entries
$$;
CREATE FUNCTION harness.historical_personal_document_proven(org uuid,node uuid,kind text,owner uuid,root uuid,volume uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT kind='personal' AND EXISTS(SELECT FROM harness.personal_document_imports r WHERE r.organization_id=org AND r.node_id=node AND r.user_id=owner
    AND r.root_id=root AND r.volume_id=volume AND r.catalog_digest=harness.personal_document_source_digest(org,node,owner)
    AND NOT EXISTS(SELECT FROM harness.document_operations o WHERE o.organization_id=org AND owner IN(o.source_user_id,o.target_user_id)))
$$;
CREATE FUNCTION harness.retain_personal_document_import() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Historical document scope evidence is immutable'; END $$;
CREATE TRIGGER retain_personal_document_import BEFORE UPDATE OR DELETE ON harness.personal_document_imports FOR EACH ROW EXECUTE FUNCTION harness.retain_personal_document_import();
CREATE VIEW harness.legacy_document_catalog AS SELECT d.* FROM harness.document_catalog d WHERE NOT EXISTS(SELECT FROM harness.personal_document_imports r
  WHERE d.organization_id=r.organization_id AND d.scope_kind='personal' AND d.node_id=r.node_id AND d.scope_user_id=r.user_id);
CREATE VIEW harness.legacy_document_checkpoints AS SELECT c.* FROM harness.document_projection_checkpoints c WHERE NOT EXISTS(SELECT FROM harness.personal_document_imports r
  WHERE c.organization_id=r.organization_id AND c.scope_kind='personal' AND c.node_id=r.node_id AND c.scope_user_id=r.user_id);
CREATE FUNCTION harness.fence_retained_document_delete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.scope_kind='personal' THEN PERFORM harness.lock_document_scope_writer(OLD.organization_id,OLD.node_id,'personal',OLD.scope_user_id,false); END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER retain_published_catalog_record BEFORE DELETE ON harness.document_catalog FOR EACH ROW EXECUTE FUNCTION harness.fence_retained_document_delete();
CREATE TRIGGER retain_published_document_cursor BEFORE DELETE ON harness.document_projection_checkpoints FOR EACH ROW EXECUTE FUNCTION harness.fence_retained_document_delete();
CREATE FUNCTION harness.fence_personal_history_write() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE item record;
BEGIN
  FOR item IN SELECT d.organization_id,d.node_id,d.scope_user_id FROM harness.document_catalog d
    WHERE d.scope_kind='personal' AND d.id IN (CASE WHEN TG_OP<>'DELETE' THEN NEW.catalog_id END,CASE WHEN TG_OP<>'INSERT' THEN OLD.catalog_id END)
    ORDER BY d.node_id,d.scope_user_id
  LOOP PERFORM harness.lock_document_scope_writer(item.organization_id,item.node_id,'personal',item.scope_user_id,false); END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER fence_personal_history_write BEFORE INSERT OR UPDATE OR DELETE ON harness.document_history FOR EACH ROW EXECUTE FUNCTION harness.fence_personal_history_write();
CREATE OR REPLACE FUNCTION harness.check_document_scope_placement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.scope_kind='project' AND
    (OLD.organization_id,OLD.scope_kind,OLD.scope_id,OLD.root_id,OLD.project_runtime_id)=(NEW.organization_id,NEW.scope_kind,NEW.scope_id,NEW.root_id,NEW.project_runtime_id)
    AND harness.project_recovery_owner(OLD.organization_id,OLD.scope_id,OLD.project_runtime_id,OLD.node_id,OLD.volume_id,OLD.writer_epoch,
      NEW.node_id,NEW.volume_id,NEW.writer_epoch) THEN RETURN NEW; END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Document scope publication is immutable'; END IF;
  IF NEW.scope_kind='personal' AND NOT EXISTS(SELECT FROM harness.users u WHERE u.organization_id=NEW.organization_id AND u.id=NEW.scope_id)
    OR NEW.scope_kind='project' AND NOT EXISTS(SELECT FROM harness.runtime_environments r
       WHERE r.organization_id=NEW.organization_id AND r.node_id=NEW.node_id AND r.owner_kind='project'
         AND r.owner_id=NEW.scope_id AND r.id=NEW.project_runtime_id AND r.retired_at IS NULL)
  THEN RAISE EXCEPTION 'Document scope owner does not match its assigned node'; END IF;
  IF harness.historical_personal_document_proven(NEW.organization_id,NEW.node_id,NEW.scope_kind,NEW.scope_id,NEW.root_id,NEW.volume_id) THEN RETURN NEW; END IF;
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
