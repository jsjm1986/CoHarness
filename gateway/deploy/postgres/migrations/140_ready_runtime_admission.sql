-- Ownership and activity share a database round trip. Each volatile command obtains its own snapshot.
CREATE FUNCTION harness.browser_runtime_admission_snapshot(
  tenant uuid, cookie_hash bytea, actor_number bigint, allocation uuid, ingress uuid
) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT to_jsonb(qualified) FROM (
  SELECT actor.public_id::text,actor.username::text,
      actor.display_name,membership.role,actor.home_path,actor.auto_review_eligible,
      runtime.owner_kind,COALESCE(owner.public_id,project.public_id)::text owner_public_id,
      node.id node_id,node.name::text node_name,node.status node_status,node.last_heartbeat_at,
      instance.generation::text,instance.observed_state,instance.stop_reason,instance.provisioning_state,instance.port,
      instance.launch_stamp,COALESCE(EXTRACT(EPOCH FROM instance.started_at)*1000,0)::float8 started_at,
      organization.access_revision::text,project.kind project_kind,
      (EXTRACT(EPOCH FROM LEAST(session.expires_at,session.absolute_expires_at,
        CASE WHEN agent.attachment_state='managed' THEN agent.lease_expires_at ELSE session.absolute_expires_at END))*1000)::float8 expires_at,
      CASE WHEN membership.role='admin' THEN 'rw' ELSE member.access_mode END project_mode,
      (membership.role='admin' OR COALESCE(project.owner_user_id=actor.id,false)) can_manage,
      CASE WHEN project.id IS NOT NULL AND harness.project_content_key(project.organization_id,project.id) IS NULL
        THEN project.name::text END legacy_project_name,
      mount.local_path legacy_project_path,
      COALESCE(control.mode,'serving') cluster_mode,COALESCE(control.write_epoch,1)::text write_epoch,
      (node.status='active' AND instance.observed_state='ready' AND instance.provisioning_state='ready'
        AND harness.runtime_node_execution_allowed(instance.organization_id,instance.assigned_node_id,
          instance.node_connection_id,instance.node_connection_epoch)
        AND EXISTS(SELECT 1 FROM harness.node_resource_runtimes resource
          WHERE resource.organization_id=instance.organization_id AND resource.node_id=instance.assigned_node_id
            AND resource.runtime_id=instance.runtime_id AND resource.generation=instance.generation
            AND resource.runtime_kind=runtime.owner_kind
            AND resource.runtime_public_id=COALESCE(owner.public_id,project.public_id))) available
      FROM harness.auth_sessions session
      JOIN harness.organizations organization ON organization.id=session.organization_id AND organization.status='active'
      LEFT JOIN harness.cluster_control control ON control.organization_id=organization.id
      JOIN harness.users actor ON actor.organization_id=session.organization_id AND actor.id=session.user_id
        AND actor.status='active' AND actor.deleted_at IS NULL
      JOIN harness.memberships membership ON membership.organization_id=actor.organization_id
        AND membership.user_id=actor.id AND membership.status='active'
      JOIN harness.password_credentials credential ON credential.user_id=actor.id AND NOT credential.must_change_password
      JOIN harness.runtime_environments runtime ON runtime.organization_id=actor.organization_id AND runtime.id=allocation AND runtime.retired_at IS NULL
      JOIN harness.instances instance ON instance.organization_id=runtime.organization_id AND instance.runtime_id=runtime.id
        AND instance.assigned_node_id=runtime.node_id
      JOIN harness.compute_nodes node ON node.organization_id=runtime.organization_id AND node.id=runtime.node_id
      LEFT JOIN harness.node_agents agent ON agent.organization_id=node.organization_id AND agent.node_id=node.id
      LEFT JOIN harness.users owner ON runtime.owner_kind='user' AND owner.organization_id=runtime.organization_id AND owner.id=runtime.owner_id
        AND owner.status='active' AND owner.deleted_at IS NULL
      LEFT JOIN harness.projects project ON runtime.owner_kind='project' AND project.organization_id=runtime.organization_id
        AND project.id=runtime.owner_id AND project.status='active'
      LEFT JOIN harness.project_mounts mount ON mount.organization_id=project.organization_id
        AND mount.project_id=project.id AND mount.node_id=runtime.node_id AND mount.status='active'
      LEFT JOIN harness.project_members member ON member.organization_id=project.organization_id
        AND member.project_id=project.id AND member.user_id=actor.id
      WHERE session.organization_id=tenant AND session.token_hash=cookie_hash AND actor.public_id=actor_number
        AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp() AND session.absolute_expires_at>clock_timestamp()
        AND harness.entry_node_visible(runtime.organization_id,ingress,runtime.node_id)
        AND harness.computer_use_allowed(runtime.organization_id,actor.id,runtime.node_id)
        AND ((runtime.owner_kind='user' AND owner.id=actor.id AND instance.user_id=owner.id)
          OR (runtime.owner_kind='project' AND instance.project_id=project.id
            AND mount.project_id IS NOT NULL
            AND ((project.kind<>'steward' AND (membership.role='admin' OR member.user_id IS NOT NULL))
              OR (project.kind='steward' AND membership.role='admin' AND EXISTS(SELECT 1 FROM harness.steward_access_policies policy
                WHERE policy.organization_id=project.organization_id AND policy.user_id=actor.id AND policy.node_id=runtime.node_id AND policy.enabled)))))
  ) qualified
$$;

-- Completion timestamps are monotone and, for exact callers, generation-bound.
CREATE OR REPLACE FUNCTION harness.record_runtime_activity(
  tenant uuid, computer uuid, owner_kind text, public_owner bigint, wanted_runtime uuid,
  activity_ms double precision, wanted_generation bigint, acquire boolean
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  owner_id uuid;
  instance_id uuid;
BEGIN
  IF owner_kind='user' THEN
    SELECT u.id INTO owner_id FROM harness.users u WHERE u.organization_id=tenant AND u.public_id=public_owner;
  ELSIF owner_kind='project' THEN
    SELECT p.id INTO owner_id FROM harness.projects p WHERE p.organization_id=tenant AND p.public_id=public_owner;
  ELSE
    RETURN false;
  END IF;
  IF owner_id IS NULL THEN RETURN false; END IF;
  IF current_setting('statement_timeout')<>'0' THEN
    PERFORM set_config('lock_timeout',current_setting('statement_timeout'),true);
  END IF;

  SELECT i.id INTO instance_id FROM harness.instances i
    WHERE i.organization_id=tenant AND i.assigned_node_id=computer
      AND (CASE WHEN owner_kind='user' THEN i.user_id ELSE i.project_id END)=owner_id
      AND (wanted_generation IS NULL OR i.generation=wanted_generation)
      AND (i.runtime_id=wanted_runtime OR (wanted_runtime IS NULL AND NOT EXISTS(
        SELECT FROM harness.instances sibling WHERE sibling.organization_id=tenant AND sibling.assigned_node_id=computer
          AND (CASE WHEN owner_kind='user' THEN sibling.user_id ELSE sibling.project_id END)=owner_id
          AND sibling.runtime_id<>i.runtime_id)))
    FOR UPDATE OF i;
  IF instance_id IS NULL THEN RETURN false; END IF;

  -- A revocation can commit while the instance lock is held by another connection.
  UPDATE harness.instances i SET last_activity_at=GREATEST(i.last_activity_at,to_timestamp(activity_ms/1000.0)),
      updated_at=GREATEST(i.updated_at,now())
    WHERE i.id=instance_id AND i.organization_id=tenant AND i.assigned_node_id=computer
      AND (CASE WHEN owner_kind='user' THEN i.user_id ELSE i.project_id END)=owner_id
      AND (wanted_generation IS NULL OR i.generation=wanted_generation)
      AND (i.runtime_id=wanted_runtime OR (wanted_runtime IS NULL AND NOT EXISTS(
        SELECT FROM harness.instances sibling WHERE sibling.organization_id=tenant AND sibling.assigned_node_id=computer
          AND (CASE WHEN owner_kind='user' THEN sibling.user_id ELSE sibling.project_id END)=owner_id
          AND sibling.runtime_id<>i.runtime_id)))
      AND (NOT acquire OR (
        i.observed_state='ready' AND i.provisioning_state='ready'
        AND harness.runtime_node_execution_allowed(tenant,computer,i.node_connection_id,i.node_connection_epoch)
        AND CASE WHEN owner_kind='user' THEN EXISTS(
          SELECT FROM harness.users u JOIN harness.memberships m ON (m.organization_id,m.user_id)=(u.organization_id,u.id)
          WHERE u.organization_id=tenant AND u.id=owner_id AND u.public_id=public_owner AND u.status='active'
            AND u.deleted_at IS NULL AND m.status='active' AND harness.computer_use_allowed(tenant,u.id,computer))
          ELSE EXISTS(SELECT FROM harness.projects p WHERE p.organization_id=tenant AND p.id=owner_id
            AND p.public_id=public_owner AND p.status='active') END
      ));
  RETURN FOUND;
END
$$;

-- Activity may wait on the instance row. The second qualification observes committed changes during that wait.
CREATE FUNCTION harness.admit_ready_browser_runtime(
  tenant uuid, cookie_hash bytea, actor_number bigint, allocation uuid, ingress uuid,
  computer uuid, wanted_generation bigint, wanted_target text, activity_ms double precision, wanted_write_epoch bigint
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE
  initial jsonb;
  current_snapshot jsonb;
  accepted boolean;
BEGIN
  initial := harness.browser_runtime_admission_snapshot(tenant,cookie_hash,actor_number,allocation,ingress);
  IF (initial->>'available')::boolean
    AND (initial->>'node_id')::uuid=computer AND (initial->>'generation')::bigint=wanted_generation
    AND initial->>'cluster_mode'='serving' AND (initial->>'write_epoch')::bigint=wanted_write_epoch
    AND (initial->>'owner_kind'='user' AND wanted_target='personal'
      OR initial->>'owner_kind'='project' AND wanted_target='project:'||(initial->>'owner_public_id')
        AND initial->>'legacy_project_name' IS NOT NULL) THEN
    accepted := harness.record_runtime_activity(tenant,computer,initial->>'owner_kind',
      (initial->>'owner_public_id')::bigint,allocation,activity_ms,wanted_generation,true);
    current_snapshot := harness.browser_runtime_admission_snapshot(tenant,cookie_hash,actor_number,allocation,ingress);
  END IF;
  RETURN jsonb_build_object('initial',initial,'current',current_snapshot,'accepted',accepted);
END
$$;
