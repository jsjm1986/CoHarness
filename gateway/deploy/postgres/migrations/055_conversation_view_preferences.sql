-- Account-scoped conversation view preferences.  NULL keeps the product
-- default while the account preference revision fences writes.  Transcript
-- detail, usage detail, and link destination follow the authenticated
-- account across personal and project runtimes.
ALTER TABLE harness.user_preferences
  ADD COLUMN transcript_view text
    CHECK (transcript_view IS NULL OR transcript_view IN ('compact', 'standard', 'detailed', 'verbose')),
  ADD COLUMN performance_usage text
    CHECK (performance_usage IS NULL OR performance_usage IN ('compact', 'detailed')),
  ADD COLUMN link_opening text
    CHECK (link_opening IS NULL OR link_opening IN ('sidebar', 'new-tab'));
