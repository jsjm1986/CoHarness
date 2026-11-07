-- Host Session, batch and interaction identifiers are local to a Runtime.
ALTER TABLE harness.conversation_sessions ADD COLUMN runtime_namespace text
  GENERATED ALWAYS AS (COALESCE(runtime_id::text,'legacy')) STORED;

ALTER TABLE harness.conversation_append_batches ADD COLUMN organization_id uuid, ADD COLUMN runtime_id uuid;
ALTER TABLE harness.conversation_events ADD COLUMN organization_id uuid, ADD COLUMN runtime_id uuid;
ALTER TABLE harness.conversation_search ADD COLUMN organization_id uuid, ADD COLUMN runtime_id uuid;
ALTER TABLE harness.conversation_participants ADD COLUMN runtime_id uuid;
ALTER TABLE harness.conversation_interaction_responses ADD COLUMN runtime_id uuid;
ALTER TABLE harness.content_files ADD COLUMN runtime_id uuid;
ALTER TABLE harness.conversation_migrations ADD COLUMN organization_id uuid, ADD COLUMN runtime_id uuid;
ALTER TABLE harness.conversation_migrated_events ADD COLUMN organization_id uuid, ADD COLUMN runtime_id uuid;
ALTER TABLE harness.conversation_draft_reservations ADD COLUMN runtime_id uuid;

UPDATE harness.conversation_append_batches child SET organization_id=session.organization_id,runtime_id=session.runtime_id
  FROM harness.conversation_sessions session WHERE child.session_id=session.id;
UPDATE harness.conversation_events child SET organization_id=session.organization_id,runtime_id=session.runtime_id
  FROM harness.conversation_sessions session WHERE child.session_id=session.id;
UPDATE harness.conversation_search child SET organization_id=session.organization_id,runtime_id=session.runtime_id
  FROM harness.conversation_sessions session WHERE child.session_id=session.id;
UPDATE harness.conversation_participants child SET runtime_id=session.runtime_id
  FROM harness.conversation_sessions session WHERE child.organization_id=session.organization_id AND child.conversation_id=session.id;
UPDATE harness.conversation_interaction_responses child SET runtime_id=session.runtime_id
  FROM harness.conversation_sessions session WHERE child.organization_id=session.organization_id AND child.conversation_id=session.id;
UPDATE harness.content_files child SET runtime_id=session.runtime_id
  FROM harness.conversation_sessions session WHERE child.organization_id=session.organization_id AND child.session_id=session.id;
UPDATE harness.conversation_migrations child SET organization_id=session.organization_id,runtime_id=session.runtime_id
  FROM harness.conversation_sessions session WHERE child.session_id=session.id;
UPDATE harness.conversation_migrated_events child SET organization_id=receipt.organization_id,runtime_id=receipt.runtime_id
  FROM harness.conversation_migrations receipt WHERE receipt.id=child.migration_id;
-- An unmaterialized reservation has no recorded Runtime witness; it stays independent until expiry.

ALTER TABLE harness.conversation_append_batches ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE harness.conversation_events ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE harness.conversation_search ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE harness.conversation_migrations ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE harness.conversation_migrated_events ALTER COLUMN organization_id SET NOT NULL;

DO $$ DECLARE owned_table text;
BEGIN
  FOREACH owned_table IN ARRAY ARRAY['conversation_append_batches','conversation_events','conversation_search',
    'conversation_participants','conversation_interaction_responses','content_files','conversation_migrations',
    'conversation_migrated_events','conversation_draft_reservations'] LOOP
    EXECUTE format('ALTER TABLE harness.%I ADD COLUMN runtime_namespace text GENERATED ALWAYS AS (COALESCE(runtime_id::text,''legacy'')) STORED',owned_table);
  END LOOP;
END $$;

DO $$ DECLARE reference record;
BEGIN
  FOR reference IN SELECT conrelid::regclass table_name,conname FROM pg_constraint
    WHERE contype='f' AND confrelid='harness.conversation_sessions'::regclass LOOP
    IF reference.table_name::text NOT IN ('harness.conversation_sessions','harness.conversation_append_batches',
      'harness.conversation_events','harness.conversation_search','harness.conversation_participants',
      'harness.conversation_interaction_responses','harness.content_files','harness.conversation_migrations') THEN
      RAISE EXCEPTION 'unclassified Session foreign key: %',reference.table_name;
    END IF;
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',reference.table_name,reference.conname);
  END LOOP;
END $$;

ALTER TABLE harness.conversation_sessions DROP CONSTRAINT conversation_sessions_pkey,
  DROP CONSTRAINT conversation_sessions_id_organization_id_key,
  ADD PRIMARY KEY(organization_id,runtime_namespace,id),
  ADD CONSTRAINT conversation_parent_runtime FOREIGN KEY(organization_id,runtime_namespace,parent_session_id)
    REFERENCES harness.conversation_sessions(organization_id,runtime_namespace,id),
  ADD CONSTRAINT conversation_root_runtime FOREIGN KEY(organization_id,runtime_namespace,root_session_id)
    REFERENCES harness.conversation_sessions(organization_id,runtime_namespace,id);

ALTER TABLE harness.conversation_append_batches DROP CONSTRAINT conversation_append_batches_pkey,
  ADD PRIMARY KEY(organization_id,runtime_namespace,batch_id),
  ADD CONSTRAINT conversation_append_session FOREIGN KEY(organization_id,runtime_namespace,session_id)
    REFERENCES harness.conversation_sessions(organization_id,runtime_namespace,id) ON DELETE CASCADE,
  ADD CONSTRAINT conversation_append_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID;
ALTER TABLE harness.conversation_events DROP CONSTRAINT conversation_events_pkey,
  ADD PRIMARY KEY(organization_id,runtime_namespace,session_id,seq),
  ADD CONSTRAINT conversation_event_session FOREIGN KEY(organization_id,runtime_namespace,session_id)
    REFERENCES harness.conversation_sessions(organization_id,runtime_namespace,id) ON DELETE CASCADE,
  ADD CONSTRAINT conversation_event_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID;
ALTER TABLE harness.conversation_search DROP CONSTRAINT conversation_search_pkey,
  ADD PRIMARY KEY(organization_id,runtime_namespace,session_id,event_seq),
  ADD CONSTRAINT conversation_search_session FOREIGN KEY(organization_id,runtime_namespace,session_id)
    REFERENCES harness.conversation_sessions(organization_id,runtime_namespace,id) ON DELETE CASCADE,
  ADD CONSTRAINT conversation_search_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID;
ALTER TABLE harness.conversation_participants DROP CONSTRAINT conversation_participants_pkey,
  ADD PRIMARY KEY(organization_id,runtime_namespace,conversation_id,user_id),
  ADD CONSTRAINT conversation_participant_session FOREIGN KEY(organization_id,runtime_namespace,conversation_id)
    REFERENCES harness.conversation_sessions(organization_id,runtime_namespace,id) ON DELETE CASCADE,
  ADD CONSTRAINT conversation_participant_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID;
ALTER TABLE harness.conversation_interaction_responses DROP CONSTRAINT conversation_interaction_responses_pkey,
  ADD PRIMARY KEY(organization_id,runtime_namespace,interaction_kind,interaction_id),
  ADD CONSTRAINT conversation_interaction_session FOREIGN KEY(organization_id,runtime_namespace,conversation_id)
    REFERENCES harness.conversation_sessions(organization_id,runtime_namespace,id) ON DELETE CASCADE,
  ADD CONSTRAINT conversation_interaction_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID;
ALTER TABLE harness.content_files
  ADD CONSTRAINT conversation_content_session FOREIGN KEY(organization_id,runtime_namespace,session_id)
    REFERENCES harness.conversation_sessions(organization_id,runtime_namespace,id),
  ADD CONSTRAINT conversation_content_runtime_registered CHECK(session_id IS NULL OR runtime_id IS NOT NULL) NOT VALID;
ALTER TABLE harness.conversation_migrations DROP CONSTRAINT conversation_migrations_session_id_migration_id_key,
  ADD CONSTRAINT conversation_migration_key UNIQUE(organization_id,runtime_namespace,session_id,migration_id),
  ADD CONSTRAINT conversation_migration_reference UNIQUE(id,organization_id,runtime_namespace,session_id),
  ADD CONSTRAINT conversation_migration_session FOREIGN KEY(organization_id,runtime_namespace,session_id)
    REFERENCES harness.conversation_sessions(organization_id,runtime_namespace,id) ON DELETE CASCADE,
  ADD CONSTRAINT conversation_migration_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID;
ALTER TABLE harness.conversation_migrated_events
  ADD CONSTRAINT conversation_migrated_event_session FOREIGN KEY(migration_id,organization_id,runtime_namespace,session_id)
    REFERENCES harness.conversation_migrations(id,organization_id,runtime_namespace,session_id) ON DELETE CASCADE,
  ADD CONSTRAINT conversation_migrated_event_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID;
ALTER TABLE harness.conversation_draft_reservations DROP CONSTRAINT conversation_draft_reservations_pkey,
  DROP CONSTRAINT conversation_draft_reservations_organization_id_session_id_key,
  ADD PRIMARY KEY(organization_id,runtime_namespace,scope_key,draft_id),
  ADD CONSTRAINT conversation_draft_session_runtime UNIQUE(organization_id,runtime_namespace,session_id),
  ADD FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
  ADD CONSTRAINT conversation_draft_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID;

CREATE OR REPLACE FUNCTION harness.bind_conversation_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_record harness.conversation_sessions%ROWTYPE;
DECLARE candidates uuid[];
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.runtime_id IS DISTINCT FROM OLD.runtime_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'conversation Runtime and Session identity are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.runtime_id IS NULL THEN
    SELECT array_agg(runtime_id) INTO candidates FROM harness.instances
      WHERE organization_id=NEW.organization_id AND
        ((NEW.project_id IS NULL AND user_id=NEW.creator_user_id) OR project_id=NEW.project_id);
    IF cardinality(candidates)<>1 OR candidates IS NULL THEN
      RAISE EXCEPTION 'conversation requires an exact Runtime assignment' USING ERRCODE='23514';
    END IF;
    NEW.runtime_id:=candidates[1];
  END IF;
  IF NOT EXISTS(SELECT 1 FROM harness.runtime_environments runtime
    WHERE runtime.id=NEW.runtime_id AND runtime.organization_id=NEW.organization_id
      AND runtime.owner_kind=CASE WHEN NEW.project_id IS NULL THEN 'user' ELSE 'project' END
      AND runtime.owner_id=COALESCE(NEW.project_id,NEW.creator_user_id)) THEN
    RAISE EXCEPTION 'conversation belongs to another Runtime' USING ERRCODE='23514';
  END IF;
  IF NEW.parent_session_id IS NOT NULL THEN
    SELECT * INTO parent_record FROM harness.conversation_sessions
      WHERE organization_id=NEW.organization_id AND runtime_namespace=NEW.runtime_id::text AND id=NEW.parent_session_id;
    IF NOT FOUND OR parent_record.root_session_id<>NEW.root_session_id THEN
      RAISE EXCEPTION 'conversation parent belongs to another Runtime or lineage root' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.root_session_id<>NEW.id THEN
    RAISE EXCEPTION 'root conversation cannot name another root' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION harness.preserve_conversation_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.runtime_id IS DISTINCT FROM OLD.runtime_id THEN
    RAISE EXCEPTION 'conversation reference is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_ARGV[0]='conversation_id' THEN
    IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
      RAISE EXCEPTION 'conversation reference is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.session_id IS DISTINCT FROM OLD.session_id THEN
    RAISE EXCEPTION 'conversation reference is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE owned_table text;
BEGIN
  FOREACH owned_table IN ARRAY ARRAY['conversation_append_batches','conversation_events','conversation_search',
    'conversation_participants','conversation_interaction_responses','content_files','conversation_migrations',
    'conversation_migrated_events','conversation_draft_reservations'] LOOP
    EXECUTE format('CREATE TRIGGER preserve_conversation_reference BEFORE UPDATE ON harness.%I
      FOR EACH ROW EXECUTE FUNCTION harness.preserve_conversation_reference(%L)',owned_table,
      CASE WHEN owned_table IN ('conversation_participants','conversation_interaction_responses') THEN 'conversation_id' ELSE 'session_id' END);
  END LOOP;
END $$;

-- Delivery and journal idempotency retain the Runtime recorded by their original source.
ALTER TABLE harness.push_deliveries ADD COLUMN runtime_id uuid;
UPDATE harness.push_deliveries delivery SET runtime_id=session.runtime_id
  FROM harness.conversation_sessions session
  WHERE session.organization_id=delivery.organization_id AND session.id=delivery.session_id;
ALTER TABLE harness.push_deliveries ADD COLUMN runtime_namespace text
  GENERATED ALWAYS AS (COALESCE(runtime_id::text,'legacy')) STORED,
  DROP CONSTRAINT push_deliveries_pkey,
  ADD PRIMARY KEY(organization_id,runtime_namespace,session_id,event_seq,device_id),
  ADD FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
  ADD CONSTRAINT push_delivery_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID;

ALTER TABLE harness.project_journal_materials ADD COLUMN runtime_id uuid;
UPDATE harness.project_journal_materials material SET runtime_id=session.runtime_id
  FROM harness.conversation_sessions session
  WHERE session.organization_id=material.organization_id AND session.id=material.session_id AND session.project_id=material.project_id;
ALTER TABLE harness.project_journal_materials ADD COLUMN runtime_namespace text
  GENERATED ALWAYS AS (COALESCE(runtime_id::text,'legacy')) STORED,
  DROP CONSTRAINT project_journal_materials_pkey,
  ADD PRIMARY KEY(organization_id,project_id,runtime_namespace,receipt),
  ADD FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id);

ALTER TABLE harness.steward_query_log ADD COLUMN runtime_id uuid;
UPDATE harness.steward_query_log log SET runtime_id=response.runtime_id
  FROM harness.conversation_interaction_responses response JOIN harness.conversation_sessions session
    ON session.organization_id=response.organization_id AND session.runtime_namespace=response.runtime_namespace AND session.id=response.conversation_id
  WHERE response.organization_id=log.organization_id AND response.interaction_kind='approval'
    AND response.interaction_id=log.approval_interaction_id AND session.project_id=log.project_id;
ALTER TABLE harness.steward_query_log ADD COLUMN runtime_namespace text
  GENERATED ALWAYS AS (COALESCE(runtime_id::text,'legacy')) STORED,
  ADD FOREIGN KEY(runtime_id,organization_id) REFERENCES harness.runtime_environments(id,organization_id),
  ADD CONSTRAINT steward_query_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID;

CREATE TRIGGER preserve_conversation_reference BEFORE UPDATE ON harness.push_deliveries
  FOR EACH ROW EXECUTE FUNCTION harness.preserve_conversation_reference('session_id');
CREATE TRIGGER preserve_conversation_reference BEFORE UPDATE ON harness.project_journal_materials
  FOR EACH ROW EXECUTE FUNCTION harness.preserve_conversation_reference('session_id');

CREATE FUNCTION harness.preserve_steward_runtime() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.runtime_id IS DISTINCT FROM OLD.runtime_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'steward query Runtime and project are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_steward_runtime BEFORE UPDATE ON harness.steward_query_log
  FOR EACH ROW EXECUTE FUNCTION harness.preserve_steward_runtime();

ALTER TABLE harness.project_journal_state ADD COLUMN watermark_runtime_namespace text;
UPDATE harness.project_journal_state state SET watermark_runtime_namespace=session.runtime_namespace
  FROM harness.conversation_sessions session
  WHERE session.organization_id=state.organization_id AND session.project_id=state.project_id AND session.id=state.watermark_session;

ALTER TABLE harness.conversation_sessions ADD CONSTRAINT conversation_project_reference
  UNIQUE(organization_id,runtime_namespace,id,project_id);
ALTER TABLE harness.project_journal_materials ADD CONSTRAINT project_material_source
  FOREIGN KEY(organization_id,runtime_namespace,session_id,project_id)
  REFERENCES harness.conversation_sessions(organization_id,runtime_namespace,id,project_id) ON DELETE CASCADE NOT VALID;
