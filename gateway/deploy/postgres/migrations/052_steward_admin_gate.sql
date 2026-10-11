-- Steward admission layered administrator membership under the qualification:
-- an enabled row grants entry only while its owner also holds an active admin
-- membership, so a grant recorded for a member — or left over after a
-- downgrade — can never admit anyone. Remove those dead rows so the table
-- only carries grants that can take effect; each delete fires the existing
-- access-invalidation trigger.
DELETE FROM harness.steward_access_policies sp
WHERE NOT EXISTS (
  SELECT 1
  FROM harness.memberships m
  JOIN harness.users u ON u.organization_id=m.organization_id AND u.id=m.user_id
  WHERE m.organization_id=sp.organization_id AND m.user_id=sp.user_id
    AND m.status='active' AND m.role='admin'
    AND u.status='active' AND u.deleted_at IS NULL);
