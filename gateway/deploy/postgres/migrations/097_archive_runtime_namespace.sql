-- Host Session identifiers are local to a Runtime; administrator operations use a stable archive identity.
ALTER TABLE harness.conversation_archive_records
  ADD COLUMN archive_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE harness.conversation_archive_search ADD COLUMN archive_id uuid, ADD COLUMN runtime_id uuid;
ALTER TABLE harness.conversation_archive_commands ADD COLUMN archive_id uuid;
ALTER TABLE harness.conversation_archive_file_cleanup ADD COLUMN archive_id uuid;

UPDATE harness.conversation_archive_search child SET archive_id=archive.archive_id,runtime_id=archive.runtime_id
  FROM harness.conversation_archive_records archive
  WHERE child.organization_id=archive.organization_id AND child.root_session_id=archive.root_session_id;
UPDATE harness.conversation_archive_commands child SET archive_id=archive.archive_id
  FROM harness.conversation_archive_records archive
  WHERE child.organization_id=archive.organization_id AND child.root_session_id=archive.root_session_id;
UPDATE harness.conversation_archive_file_cleanup child SET archive_id=archive.archive_id
  FROM harness.conversation_archive_records archive
  WHERE child.organization_id=archive.organization_id AND child.root_session_id=archive.root_session_id;
ALTER TABLE harness.conversation_archive_search ALTER COLUMN archive_id SET NOT NULL;
ALTER TABLE harness.conversation_archive_commands ALTER COLUMN archive_id SET NOT NULL;
ALTER TABLE harness.conversation_archive_file_cleanup ALTER COLUMN archive_id SET NOT NULL;

DO $$ DECLARE reference record;
BEGIN
  FOR reference IN SELECT conrelid::regclass table_name,conname FROM pg_constraint
    WHERE contype='f' AND confrelid='harness.conversation_archive_records'::regclass
      AND conrelid=ANY(ARRAY['harness.conversation_archive_search'::regclass,
        'harness.conversation_archive_commands'::regclass,'harness.conversation_archive_file_cleanup'::regclass])
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',reference.table_name,reference.conname);
  END LOOP;
END $$;

ALTER TABLE harness.conversation_archive_records DROP CONSTRAINT conversation_archive_records_pkey,
  ADD PRIMARY KEY(archive_id),
  ADD CONSTRAINT archive_record_organization UNIQUE(organization_id,archive_id),
  ADD CONSTRAINT archive_record_runtime_identity UNIQUE NULLS NOT DISTINCT(organization_id,runtime_id,root_session_id),
  ADD CONSTRAINT archive_record_runtime_reference UNIQUE(organization_id,archive_id,runtime_id),
  ADD CONSTRAINT archive_record_node_reference UNIQUE(organization_id,archive_id,node_id);

ALTER TABLE harness.conversation_archive_search DROP CONSTRAINT conversation_archive_search_pkey,
  DROP COLUMN root_session_id,
  ADD PRIMARY KEY(organization_id,archive_id,session_id,event_seq),
  ADD CONSTRAINT archive_search_runtime_event UNIQUE NULLS NOT DISTINCT(organization_id,runtime_id,session_id,event_seq),
  ADD CONSTRAINT archive_search_record FOREIGN KEY(organization_id,archive_id)
    REFERENCES harness.conversation_archive_records(organization_id,archive_id) ON DELETE CASCADE,
  ADD CONSTRAINT archive_search_runtime FOREIGN KEY(organization_id,archive_id,runtime_id)
    REFERENCES harness.conversation_archive_records(organization_id,archive_id,runtime_id) ON DELETE CASCADE,
  ADD CONSTRAINT archive_search_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID;
CREATE INDEX conversation_archive_search_record_time
  ON harness.conversation_archive_search(organization_id,archive_id,occurred_at DESC);

ALTER TABLE harness.conversation_archive_commands DROP COLUMN root_session_id,
  ADD CONSTRAINT archive_command_record FOREIGN KEY(organization_id,archive_id)
    REFERENCES harness.conversation_archive_records(organization_id,archive_id) ON DELETE CASCADE;
CREATE INDEX conversation_archive_commands_record_pending
  ON harness.conversation_archive_commands(organization_id,archive_id,requested_at) WHERE status='pending';

ALTER TABLE harness.conversation_archive_file_cleanup
  DROP COLUMN root_session_id,
  ADD CONSTRAINT archive_file_cleanup_record_path UNIQUE(organization_id,archive_id,local_path),
  ADD CONSTRAINT archive_file_cleanup_record FOREIGN KEY(organization_id,archive_id)
    REFERENCES harness.conversation_archive_records(organization_id,archive_id) ON DELETE CASCADE,
  ADD CONSTRAINT archive_file_cleanup_node FOREIGN KEY(organization_id,archive_id,node_id)
    REFERENCES harness.conversation_archive_records(organization_id,archive_id,node_id) ON DELETE CASCADE;

CREATE FUNCTION harness.preserve_archive_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.archive_id IS DISTINCT FROM OLD.archive_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.root_session_id IS DISTINCT FROM OLD.root_session_id OR NEW.runtime_kind IS DISTINCT FROM OLD.runtime_kind
    OR NEW.runtime_public_id IS DISTINCT FROM OLD.runtime_public_id THEN
    RAISE EXCEPTION 'archive identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_archive_identity BEFORE UPDATE ON harness.conversation_archive_records
  FOR EACH ROW EXECUTE FUNCTION harness.preserve_archive_identity();
