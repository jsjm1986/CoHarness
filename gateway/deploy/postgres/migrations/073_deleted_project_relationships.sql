-- Deleted accounts retain history, but cannot retain project membership or invitation grants.
DELETE FROM harness.project_invitations i USING harness.users u
  WHERE u.organization_id=i.organization_id AND u.deleted_at IS NOT NULL
    AND (i.invitee_user_id=u.id OR i.inviter_user_id=u.id);
DELETE FROM harness.project_members m USING harness.users u
  WHERE m.organization_id=u.organization_id AND m.user_id=u.id AND u.deleted_at IS NOT NULL;
