-- Model choices belong to live project draft reservations until the first conversation append.
ALTER TABLE harness.conversation_draft_reservations ADD COLUMN model_selection jsonb
  CHECK (model_selection IS NULL OR (project_id IS NOT NULL AND jsonb_typeof(model_selection) = 'object'));
