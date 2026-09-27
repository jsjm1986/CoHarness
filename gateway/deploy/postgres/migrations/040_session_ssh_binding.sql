-- Session-bound SSH execution: the session records which registered target its
-- providers ran on so a resume re-authorizes the same host instead of silently
-- relocalizing remote paths. Deliberately NOT a foreign key: deleting a target
-- must not be blocked by referencing sessions, and the surviving binding is what
-- lets the next resume report the loss rather than fall back to host-local
-- execution.
ALTER TABLE harness.conversation_sessions
  ADD COLUMN ssh_target_id bigint;

-- Draft reservations bind the same target so a draft reserved under one SSH
-- binding cannot be renewed or materialized under another.
ALTER TABLE harness.conversation_draft_reservations
  ADD COLUMN ssh_target_id bigint;

-- A registered target may name a credential reference resolved inside the
-- connecting runtime (managed credentials file, environment provider). The
-- reference name is stored, never the secret; dsh-ssh feeds it to OpenSSH
-- through SSH_ASKPASS under the connection's private directory.
ALTER TABLE harness.ssh_targets
  ADD COLUMN password_ref text CHECK (password_ref IS NULL OR password_ref ~ '^[A-Za-z_][A-Za-z0-9_]*$');
