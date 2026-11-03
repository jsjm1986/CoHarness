ALTER TABLE harness.conversation_sessions ADD COLUMN runtime_id uuid;
UPDATE harness.conversation_sessions session SET runtime_id=instance.runtime_id FROM harness.instances instance
  WHERE instance.organization_id=session.organization_id AND
    ((session.project_id IS NULL AND instance.user_id=session.creator_user_id) OR instance.project_id=session.project_id);
ALTER TABLE harness.conversation_sessions
  ADD FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
  ADD CONSTRAINT conversation_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID;
CREATE INDEX conversation_runtime_sessions ON harness.conversation_sessions(organization_id,runtime_id,updated_at DESC,id);

CREATE FUNCTION harness.bind_conversation_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_runtime uuid;
DECLARE candidates uuid[];
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.runtime_id IS DISTINCT FROM OLD.runtime_id THEN
      RAISE EXCEPTION 'conversation Runtime is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.parent_session_id IS NOT NULL THEN
    SELECT runtime_id INTO parent_runtime FROM harness.conversation_sessions
      WHERE organization_id=NEW.organization_id AND id=NEW.parent_session_id;
  END IF;
  IF NEW.runtime_id IS NULL THEN
    IF parent_runtime IS NOT NULL THEN NEW.runtime_id:=parent_runtime;
    ELSE
      SELECT array_agg(runtime_id) INTO candidates FROM harness.instances
        WHERE organization_id=NEW.organization_id AND
          ((NEW.project_id IS NULL AND user_id=NEW.creator_user_id) OR project_id=NEW.project_id);
      IF cardinality(candidates)<>1 OR candidates IS NULL THEN
        RAISE EXCEPTION 'conversation requires an exact Runtime assignment' USING ERRCODE='23514';
      END IF;
      NEW.runtime_id:=candidates[1];
    END IF;
  END IF;
  IF parent_runtime IS NOT NULL AND parent_runtime<>NEW.runtime_id OR NOT EXISTS(
    SELECT 1 FROM harness.runtime_environments runtime WHERE runtime.id=NEW.runtime_id AND runtime.organization_id=NEW.organization_id
      AND runtime.owner_kind=CASE WHEN NEW.project_id IS NULL THEN 'user' ELSE 'project' END
      AND runtime.owner_id=COALESCE(NEW.project_id,NEW.creator_user_id)) THEN
    RAISE EXCEPTION 'conversation belongs to another Runtime' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bind_conversation_runtime BEFORE INSERT OR UPDATE ON harness.conversation_sessions
  FOR EACH ROW EXECUTE FUNCTION harness.bind_conversation_runtime();

ALTER TABLE harness.conversation_archive_records
  ADD COLUMN runtime_id uuid, ADD COLUMN node_id uuid, ADD COLUMN legacy_unassigned boolean NOT NULL DEFAULT false;
UPDATE harness.conversation_archive_records archive SET runtime_id=instance.runtime_id,node_id=instance.assigned_node_id
  FROM harness.instances instance
  LEFT JOIN harness.users account ON account.organization_id=instance.organization_id AND account.id=instance.user_id
  LEFT JOIN harness.projects project ON project.organization_id=instance.organization_id AND project.id=instance.project_id
  WHERE archive.organization_id=instance.organization_id
    AND archive.runtime_kind=CASE WHEN instance.user_id IS NULL THEN 'project' ELSE 'user' END
    AND archive.runtime_public_id=COALESCE(account.public_id,project.public_id);
-- Unassigned historical records remain administrator metadata and authorize no Runtime.
UPDATE harness.conversation_archive_records archive SET node_id=single_node.id FROM
  (SELECT organization_id,(array_agg(id))[1] id FROM harness.compute_nodes GROUP BY organization_id HAVING count(*)=1) single_node
  WHERE archive.organization_id=single_node.organization_id AND archive.node_id IS NULL;
UPDATE harness.conversation_archive_records SET legacy_unassigned=true WHERE runtime_id IS NULL OR node_id IS NULL;
ALTER TABLE harness.conversation_archive_records
  ADD FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
  ADD FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
  ADD CONSTRAINT archive_runtime_registered CHECK(legacy_unassigned OR runtime_id IS NOT NULL AND node_id IS NOT NULL);
CREATE INDEX conversation_archive_runtime ON harness.conversation_archive_records(organization_id,node_id,runtime_id,root_session_id);

ALTER TABLE harness.conversation_archive_file_cleanup ADD COLUMN node_id uuid;
UPDATE harness.conversation_archive_file_cleanup cleanup SET node_id=archive.node_id FROM harness.conversation_archive_records archive
  WHERE archive.organization_id=cleanup.organization_id AND archive.root_session_id=cleanup.root_session_id;
ALTER TABLE harness.conversation_archive_file_cleanup
  ADD FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
  ADD CONSTRAINT archive_cleanup_computer CHECK(node_id IS NOT NULL) NOT VALID;
CREATE INDEX conversation_archive_cleanup_node ON harness.conversation_archive_file_cleanup(organization_id,node_id,next_attempt_at,id);

CREATE FUNCTION harness.preserve_archive_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.runtime_id IS DISTINCT FROM OLD.runtime_id OR NEW.node_id IS DISTINCT FROM OLD.node_id
    OR NEW.legacy_unassigned IS DISTINCT FROM OLD.legacy_unassigned) THEN
    RAISE EXCEPTION 'archive Runtime and computer are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND (NEW.legacy_unassigned OR NOT EXISTS(SELECT 1 FROM harness.runtime_environments runtime
    LEFT JOIN harness.users account ON runtime.owner_kind='user' AND account.organization_id=runtime.organization_id AND account.id=runtime.owner_id
    LEFT JOIN harness.projects project ON runtime.owner_kind='project' AND project.organization_id=runtime.organization_id AND project.id=runtime.owner_id
    WHERE runtime.id=NEW.runtime_id AND runtime.organization_id=NEW.organization_id AND runtime.node_id=NEW.node_id
      AND runtime.owner_kind=NEW.runtime_kind AND COALESCE(account.public_id,project.public_id)=NEW.runtime_public_id)) THEN
    RAISE EXCEPTION 'archive belongs to another Runtime' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_archive_runtime BEFORE INSERT OR UPDATE ON harness.conversation_archive_records
  FOR EACH ROW EXECUTE FUNCTION harness.preserve_archive_runtime();
