-- Account-scoped conversation display preferences.  NULL keeps the product
-- default while allowing the account preference revision to fence writes.
ALTER TABLE harness.user_preferences
  ADD COLUMN chat_content_width integer
    CHECK (chat_content_width IS NULL OR chat_content_width BETWEEN 560 AND 1080),
  ADD COLUMN chat_font_size integer
    CHECK (chat_font_size IS NULL OR chat_font_size BETWEEN 12 AND 17);
