-- Legacy reservations have no operation owner and remain held until confirmed Runtime stop.
ALTER TABLE harness.node_resource_requests ADD COLUMN operation_id uuid;

CREATE UNIQUE INDEX node_resource_operation ON harness.node_resource_requests
  (organization_id,node_id,runtime_kind,runtime_public_id,generation,operation_id)
  WHERE operation_id IS NOT NULL;
