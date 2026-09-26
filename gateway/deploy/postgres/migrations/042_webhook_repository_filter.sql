-- Structured repository filter on webhook endpoints. Entries are exact
-- `owner/repo` full names matched case-insensitively against the verified
-- payload's `repository.full_name`; an empty list accepts every repository.
ALTER TABLE harness.webhook_endpoints
  ADD COLUMN repositories text[] NOT NULL DEFAULT '{}' CHECK (cardinality(repositories) <= 64);
