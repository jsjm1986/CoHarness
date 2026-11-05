-- Backup content and detailed manifests belong to the nodes. The organization retains approvals and receipts.
CREATE TABLE harness.peer_backup_policies (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  scope_kind text NOT NULL CHECK(scope_kind IN ('project','personal','governance')),
  scope_id uuid NOT NULL, source_node_id uuid NOT NULL, target_node_id uuid NOT NULL,
  tier text NOT NULL CHECK(tier IN ('important','ordinary')), enabled boolean NOT NULL,
  revision integer NOT NULL CHECK(revision>0), quota_bytes bigint NOT NULL CHECK(quota_bytes>0),
  append_hash text NOT NULL CHECK(append_hash ~ '^[a-f0-9]{64}$'),
  recovery_hash text NOT NULL CHECK(recovery_hash ~ '^[a-f0-9]{64}$' AND recovery_hash<>append_hash),
  next_capture_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,organization_id), CHECK(source_node_id<>target_node_id),
  FOREIGN KEY(source_node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id),
  FOREIGN KEY(target_node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id)
);
CREATE UNIQUE INDEX peer_backup_one_destination ON harness.peer_backup_policies(organization_id,scope_kind,scope_id) WHERE enabled;
CREATE TABLE harness.peer_backup_work (
  id uuid PRIMARY KEY, policy_id uuid NOT NULL, organization_id uuid NOT NULL, revision integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('capture','drill')), node_id uuid NOT NULL, point_id uuid,
  status text NOT NULL CHECK(status IN ('queued','running','confirmed','failed')),
  phase text, pending_bytes bigint CHECK(pending_bytes>=0), error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  claim uuid, lease_expires_at timestamptz, recovery_ms bigint CHECK(recovery_ms>=0),
  CHECK((kind='capture' AND point_id IS NULL) OR (kind='drill' AND point_id IS NOT NULL)),
  FOREIGN KEY(policy_id,organization_id) REFERENCES harness.peer_backup_policies(id,organization_id),
  FOREIGN KEY(node_id,organization_id) REFERENCES harness.compute_nodes(id,organization_id)
);
CREATE UNIQUE INDEX peer_backup_one_pending_capture ON harness.peer_backup_work(policy_id) WHERE kind='capture' AND status IN ('queued','running');
CREATE INDEX peer_backup_recent_work ON harness.peer_backup_work(organization_id,policy_id,created_at DESC);
CREATE TABLE harness.peer_backup_points (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, policy_id uuid NOT NULL, revision integer NOT NULL,
  writer_epoch bigint NOT NULL CHECK(writer_epoch>0), watermark bigint NOT NULL CHECK(watermark>=0),
  snapshot_id text NOT NULL CHECK(snapshot_id ~ '^[a-f0-9]{64}$'),
  manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),
  covered_count integer NOT NULL CHECK(covered_count>=0), gap_count integer NOT NULL CHECK(gap_count>=0),
  gap_types text[] NOT NULL DEFAULT '{}' CHECK(gap_types <@ ARRAY['files','plugins','database','unknown']::text[] AND cardinality(gap_types)<=4),
  repository_bytes bigint CHECK(repository_bytes>=0), available_bytes bigint CHECK(available_bytes>=0),
  protected_through timestamptz NOT NULL, confirmed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(policy_id,organization_id) REFERENCES harness.peer_backup_policies(id,organization_id)
);
CREATE INDEX peer_backup_recent_points ON harness.peer_backup_points(organization_id,policy_id,protected_through DESC);
