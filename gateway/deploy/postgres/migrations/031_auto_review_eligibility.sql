-- Eligibility is an administrator grant, independent of a Session's selected preset.
ALTER TABLE harness.users
  ADD COLUMN auto_review_eligible boolean NOT NULL DEFAULT false;

DROP TRIGGER users_access ON harness.users;
CREATE TRIGGER users_access BEFORE UPDATE OF status,deleted_at,home_path,auto_review_eligible OR DELETE ON harness.users
  FOR EACH ROW EXECUTE FUNCTION harness.capture_access_invalidation('status,deleted_at,home_path,auto_review_eligible');
