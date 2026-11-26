-- Keep model choices in the content store that owns the corresponding draft.
ALTER TABLE node_content.conversation_draft_reservations ADD COLUMN model_selection jsonb
  CHECK (model_selection IS NULL OR (project_id IS NOT NULL AND jsonb_typeof(model_selection) = 'object'));
