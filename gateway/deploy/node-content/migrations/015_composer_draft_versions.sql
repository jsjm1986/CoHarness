ALTER TABLE node_content.composer_drafts
  ADD COLUMN previous_versions bytea NOT NULL DEFAULT decode('5b5d','hex');
