-- Administrator-selected default route for the project progress digest, in
-- 'provider/model' form. NULL leaves the digest on catalog order. Applied at
-- read time per pass, so a change takes effect without a restart.

ALTER TABLE harness.organizations
  ADD COLUMN digest_model text;
