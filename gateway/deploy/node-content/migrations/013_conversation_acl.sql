-- Slow reads retain only their original snapshot; final disclosure locks this small authorization row.
CREATE TABLE node_content.conversation_acl_versions (
  organization_id uuid NOT NULL, runtime_id uuid NOT NULL, project_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), PRIMARY KEY(organization_id,runtime_id),
  FOREIGN KEY(organization_id,runtime_id,project_id) REFERENCES node_content.spaces(organization_id,runtime_id,project_id) ON DELETE CASCADE
);
INSERT INTO node_content.conversation_acl_versions(organization_id,runtime_id,project_id)
  SELECT organization_id,runtime_id,project_id FROM node_content.spaces;
CREATE FUNCTION node_content.initialize_conversation_acl() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  INSERT INTO node_content.conversation_acl_versions(organization_id,runtime_id,project_id) VALUES(NEW.organization_id,NEW.runtime_id,NEW.project_id);
  RETURN NULL;
END $$;
CREATE TRIGGER initialize_conversation_acl AFTER INSERT ON node_content.spaces
  FOR EACH ROW EXECUTE FUNCTION node_content.initialize_conversation_acl();
CREATE FUNCTION node_content.advance_conversation_acl() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    UPDATE node_content.conversation_acl_versions SET revision=revision+1 WHERE organization_id=OLD.organization_id AND runtime_id=OLD.runtime_id;
  END IF;
  IF TG_OP='INSERT' OR TG_OP='UPDATE' AND (NEW.organization_id,NEW.runtime_id) IS DISTINCT FROM (OLD.organization_id,OLD.runtime_id) THEN
    UPDATE node_content.conversation_acl_versions SET revision=revision+1 WHERE organization_id=NEW.organization_id AND runtime_id=NEW.runtime_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER advance_conversation_acl_on_change AFTER UPDATE ON node_content.conversation_sessions FOR EACH ROW
  WHEN ((OLD.organization_id,OLD.runtime_id,OLD.project_id,OLD.id,OLD.root_session_id,OLD.parent_session_id,OLD.visibility,OLD.creator_user_id,OLD.status)
    IS DISTINCT FROM (NEW.organization_id,NEW.runtime_id,NEW.project_id,NEW.id,NEW.root_session_id,NEW.parent_session_id,NEW.visibility,NEW.creator_user_id,NEW.status))
  EXECUTE FUNCTION node_content.advance_conversation_acl();
CREATE TRIGGER advance_conversation_acl_on_delete AFTER DELETE ON node_content.conversation_sessions
  FOR EACH ROW EXECUTE FUNCTION node_content.advance_conversation_acl();
CREATE TRIGGER advance_conversation_acl_on_archive_change AFTER UPDATE ON node_content.conversation_archive_records FOR EACH ROW
  WHEN ((OLD.organization_id,OLD.runtime_id,OLD.root_session_id,OLD.state,OLD.restored_at) IS DISTINCT FROM
    (NEW.organization_id,NEW.runtime_id,NEW.root_session_id,NEW.state,NEW.restored_at)) EXECUTE FUNCTION node_content.advance_conversation_acl();
CREATE TRIGGER advance_conversation_acl_on_archive AFTER INSERT OR DELETE ON node_content.conversation_archive_records
  FOR EACH ROW EXECUTE FUNCTION node_content.advance_conversation_acl();
