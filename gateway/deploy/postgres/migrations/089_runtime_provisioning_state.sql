ALTER TABLE harness.instances ADD COLUMN provisioning_state text NOT NULL DEFAULT 'ready'
  CHECK(provisioning_state IN ('preparing','ready'));

CREATE FUNCTION harness.guard_runtime_provisioning() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provisioning_state<>'ready' AND (NEW.observed_state IN ('starting','ready') OR NEW.runtime_token_hash IS NOT NULL)
    OR TG_OP='UPDATE' AND OLD.provisioning_state='ready' AND NEW.provisioning_state<>'ready' THEN
    RAISE EXCEPTION 'Runtime local storage is not provisioned' USING ERRCODE='23514',CONSTRAINT='runtime_provisioning';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_runtime_provisioning BEFORE INSERT OR UPDATE ON harness.instances
  FOR EACH ROW EXECUTE FUNCTION harness.guard_runtime_provisioning();
