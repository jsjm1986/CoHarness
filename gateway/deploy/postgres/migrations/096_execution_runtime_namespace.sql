-- Preserve Host Session IDs while binding every execution witness to its Runtime.
DO $$
DECLARE reference record;
BEGIN
  FOR reference IN SELECT conrelid::regclass relation,conname FROM pg_constraint
    WHERE contype='f' AND confrelid='harness.execution_sessions'::regclass
      AND conrelid IN ('harness.execution_sessions'::regclass,'harness.execution_inputs'::regclass,
        'harness.execution_relays'::regclass,'harness.execution_scopes'::regclass,
        'harness.desktop_session_confirmations'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',reference.relation,reference.conname);
  END LOOP;
END $$;

ALTER TABLE harness.execution_sessions
  DROP CONSTRAINT execution_sessions_pkey,
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD PRIMARY KEY(id),
  ADD CONSTRAINT execution_session_runtime_unique
    UNIQUE NULLS NOT DISTINCT(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id),
  ADD CONSTRAINT execution_session_parent_runtime
    FOREIGN KEY(organization_id,runtime_kind,runtime_public_id,parent_session_id,runtime_id)
      REFERENCES harness.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id);

ALTER TABLE harness.execution_inputs ADD COLUMN runtime_id uuid;
ALTER TABLE harness.execution_relays ADD COLUMN runtime_id uuid;
ALTER TABLE harness.execution_scopes ADD COLUMN runtime_id uuid;
ALTER TABLE harness.desktop_session_confirmations ADD COLUMN runtime_id uuid;

-- Backfill only the immutable Session's recorded Runtime; unassigned history remains unassigned.
ALTER TABLE harness.execution_inputs DISABLE TRIGGER execution_inputs_immutable;
ALTER TABLE harness.execution_scopes DISABLE TRIGGER execution_scopes_immutable;
UPDATE harness.execution_inputs input SET runtime_id=session.runtime_id FROM harness.execution_sessions session
  WHERE input.organization_id=session.organization_id AND input.runtime_kind=session.runtime_kind
    AND input.runtime_public_id=session.runtime_public_id AND input.session_id=session.session_id;
UPDATE harness.execution_relays relay SET runtime_id=session.runtime_id FROM harness.execution_sessions session
  WHERE relay.organization_id=session.organization_id AND relay.runtime_kind=session.runtime_kind
    AND relay.runtime_public_id=session.runtime_public_id AND relay.session_id=session.session_id;
UPDATE harness.execution_scopes scope SET runtime_id=session.runtime_id FROM harness.execution_sessions session
  WHERE scope.organization_id=session.organization_id AND scope.runtime_kind=session.runtime_kind
    AND scope.runtime_public_id=session.runtime_public_id AND scope.session_id=session.session_id;
UPDATE harness.desktop_session_confirmations confirmation SET runtime_id=session.runtime_id FROM harness.execution_sessions session
  WHERE confirmation.organization_id=session.organization_id AND confirmation.runtime_kind=session.runtime_kind
    AND confirmation.runtime_public_id=session.runtime_public_id AND confirmation.session_id=session.session_id;
ALTER TABLE harness.execution_inputs ENABLE TRIGGER execution_inputs_immutable;
ALTER TABLE harness.execution_scopes ENABLE TRIGGER execution_scopes_immutable;

DROP INDEX harness.execution_inputs_first;
CREATE UNIQUE INDEX execution_inputs_first
  ON harness.execution_inputs(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,message_id,kind)
  WHERE previous_input_id IS NULL;
ALTER TABLE harness.execution_relays DROP CONSTRAINT execution_relays_pkey,
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(), ADD PRIMARY KEY(id),
  ADD CONSTRAINT execution_relay_runtime_unique
    UNIQUE NULLS NOT DISTINCT(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,message_id);
ALTER TABLE harness.execution_scopes DROP CONSTRAINT execution_scopes_organization_id_runtime_kind_runtime_publi_key;
ALTER TABLE harness.execution_scopes ADD CONSTRAINT execution_scope_runtime_unique
  UNIQUE NULLS NOT DISTINCT(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,fingerprint);
ALTER TABLE harness.desktop_session_confirmations DROP CONSTRAINT desktop_session_confirmations_pkey,
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(), ADD PRIMARY KEY(id),
  ADD CONSTRAINT desktop_confirmation_runtime_unique
    UNIQUE NULLS NOT DISTINCT(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id,node_id,generation,desktop,user_id);

ALTER TABLE harness.execution_inputs
  ADD CONSTRAINT execution_input_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT execution_input_runtime_session FOREIGN KEY(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id)
    REFERENCES harness.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id);
ALTER TABLE harness.execution_relays
  ADD CONSTRAINT execution_relay_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT execution_relay_runtime_session FOREIGN KEY(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id)
    REFERENCES harness.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id);
ALTER TABLE harness.execution_scopes
  ADD CONSTRAINT execution_scope_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT execution_scope_runtime_session FOREIGN KEY(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id)
    REFERENCES harness.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id);
ALTER TABLE harness.desktop_session_confirmations
  ADD CONSTRAINT desktop_confirmation_runtime_registered CHECK(runtime_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT desktop_confirmation_runtime_session FOREIGN KEY(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id)
    REFERENCES harness.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id,runtime_id) ON DELETE CASCADE;
