-- Deleted identities retain usage history but cannot own active model configuration.
DELETE FROM harness.model_user_access access
USING harness.users account
WHERE access.user_id=account.id AND access.organization_id=account.organization_id
  AND account.deleted_at IS NOT NULL;

DELETE FROM harness.user_quotas quota
USING harness.users account
WHERE quota.user_id=account.id AND account.deleted_at IS NOT NULL;
