-- Immutable execution participants outlive the Session's current request.
CREATE TABLE harness.execution_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  runtime_kind text NOT NULL,
  runtime_public_id bigint NOT NULL,
  session_id text NOT NULL,
  fingerprint text NOT NULL,
  revision bigint NOT NULL,
  input_ids uuid[] NOT NULL,
  primary_actor_user_id uuid,
  unverified boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,runtime_kind,runtime_public_id,session_id)
    REFERENCES harness.execution_sessions(organization_id,runtime_kind,runtime_public_id,session_id),
  UNIQUE (organization_id,runtime_kind,runtime_public_id,session_id,fingerprint),
  CHECK (cardinality(input_ids)>0 OR (unverified AND primary_actor_user_id IS NULL))
);

CREATE FUNCTION harness.preserve_execution_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'execution scopes are immutable';
END;
$$;
CREATE TRIGGER execution_scopes_immutable BEFORE UPDATE OR DELETE ON harness.execution_scopes
  FOR EACH ROW EXECUTE FUNCTION harness.preserve_execution_scope();
