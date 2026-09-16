-- Preserved predecessor bodies may contain valid JSON strings with escaped
-- NUL, the same payload class migration 004 allowed in conversation_events.
-- PostgreSQL json preserves those strings; jsonb rejects them while decoding,
-- which failed the receipt copy in ConversationRepository.migrate.
ALTER TABLE harness.conversation_migrated_events
  ALTER COLUMN event TYPE json
  USING event::text::json;
