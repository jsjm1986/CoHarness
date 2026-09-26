-- Deployment control plane: maintenance windows with writer convergence, a
-- monotonic write epoch fencing stale writers after a restore, an operation
-- ledger, and a backup registry binding dumps to managed-file manifests.

CREATE TABLE harness.cluster_control (
  organization_id uuid PRIMARY KEY REFERENCES harness.organizations(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'serving' CHECK (mode IN ('serving','maintenance','restoring')),
  maintenance_epoch bigint NOT NULL DEFAULT 0 CHECK (maintenance_epoch >= 0),
  write_epoch bigint NOT NULL DEFAULT 1 CHECK (write_epoch >= 1),
  reason text,
  actor_user_id uuid,
  entered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Each Gateway node acknowledges the maintenance epoch it has applied. The
-- standalone applier waits for every fresh node before restore; a node that
-- stops heartbeating stays unquiesced rather than being assumed drained.
ALTER TABLE harness.compute_nodes
  ADD COLUMN maintenance_applied_epoch bigint NOT NULL DEFAULT 0 CHECK (maintenance_applied_epoch >= 0);

CREATE TABLE harness.deployment_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('enter-maintenance','exit-maintenance','apply','backup','restore','node-status')),
  status text NOT NULL CHECK (status IN ('pending','running','completed','failed','aborted')),
  node_name text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  error text
);
CREATE INDEX deployment_operations_recent
  ON harness.deployment_operations(organization_id, created_at DESC);
-- The applier claims at most one pending restore at a time.
CREATE UNIQUE INDEX deployment_operations_pending_restore
  ON harness.deployment_operations(organization_id) WHERE kind='restore' AND status='pending';

CREATE TABLE harness.backup_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  path text NOT NULL,
  format text NOT NULL DEFAULT 'pg-dump-custom',
  migration_version integer NOT NULL CHECK (migration_version >= 0),
  write_epoch bigint NOT NULL CHECK (write_epoch >= 1),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256 char(64) CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  managed_files jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'recording' CHECK (status IN ('recording','verified','failed','restored')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  restored_at timestamptz,
  error text
);
CREATE INDEX backup_records_recent
  ON harness.backup_records(organization_id, created_at DESC);
