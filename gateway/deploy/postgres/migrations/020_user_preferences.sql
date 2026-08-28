-- Account-scoped browser preferences.  These values are deliberately kept
-- outside a runtime's settings document: a project runtime is shared by
-- several accounts, while language/theme/Enter preferences belong to one
-- authenticated user.
CREATE TABLE harness.user_preferences (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  locale_preference text,
  theme_preference text,
  busy_enter text,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  migrated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id),
  FOREIGN KEY (user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE CASCADE,
  CHECK (locale_preference IS NULL OR locale_preference IN ('zh', 'en')),
  CHECK (theme_preference IS NULL OR theme_preference IN ('light', 'dark', 'system')),
  CHECK (busy_enter IS NULL OR busy_enter IN ('queue', 'steer'))
);

CREATE INDEX user_preferences_updated
  ON harness.user_preferences(organization_id, updated_at DESC);
