-- A recovered lease cannot authorize a delayed predecessor to publish or clear its successor's state.
ALTER TABLE harness.project_journal_state ADD COLUMN generation_id uuid;
