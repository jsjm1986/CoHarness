-- Backfill terminal access for administrator accounts only; member and project policies keep deny-by-default.
INSERT INTO harness.terminal_access_policies (organization_id,user_id,enabled,revision)
SELECT m.organization_id,m.user_id,true,1
FROM harness.memberships m JOIN harness.users u ON u.organization_id=m.organization_id AND u.id=m.user_id
WHERE m.role='admin' AND u.deleted_at IS NULL
ON CONFLICT DO NOTHING;
