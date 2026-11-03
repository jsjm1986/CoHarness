-- Destructive work may retain stopping state while its process tree is already confirmed gone.
ALTER TABLE harness.runtime_destructive_operations ADD COLUMN quiescent_at timestamptz;
