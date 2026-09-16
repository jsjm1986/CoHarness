-- Account-scoped transcript fill-width preference.  NULL keeps the product
-- default (fixed content width) while the account revision fences writes.
ALTER TABLE harness.user_preferences
  ADD COLUMN chat_full_width boolean;
