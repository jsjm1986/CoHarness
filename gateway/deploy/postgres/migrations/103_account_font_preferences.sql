ALTER TABLE harness.user_preferences
  ADD COLUMN font_size integer CHECK (font_size BETWEEN 10 AND 22),
  ADD COLUMN code_font_size integer CHECK (code_font_size BETWEEN 10 AND 16),
  ADD COLUMN terminal_font_size integer CHECK (terminal_font_size BETWEEN 10 AND 20),
  ADD COLUMN text_font_family text,
  ADD COLUMN code_font_family text,
  ADD COLUMN terminal_font_family text,
  ADD COLUMN theme_fonts_migrated_at timestamptz;
