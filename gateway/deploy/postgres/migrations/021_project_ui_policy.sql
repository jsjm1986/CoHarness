ALTER TABLE harness.projects
  ADD COLUMN ui_theme_policy text NOT NULL DEFAULT 'follow-user'
    CHECK (ui_theme_policy IN ('follow-user', 'light', 'dark'));
