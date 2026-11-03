-- Admit Windows nodes alongside macOS and Linux; connectivity-only enrollment
-- still reports executionReady=false until Windows local Runtime support lands.
ALTER TABLE harness.node_agents DROP CONSTRAINT node_agents_platform_check,
  ADD CONSTRAINT node_agents_platform_check CHECK (platform IN ('darwin','linux','win32'));
