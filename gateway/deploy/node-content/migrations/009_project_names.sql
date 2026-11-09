-- Governance selects an opaque version only after uniqueness and authorization commit.
CREATE TABLE node_content.project_name_versions (
  organization_id uuid NOT NULL,project_id uuid NOT NULL,runtime_id uuid NOT NULL,version_id uuid NOT NULL,
  name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,project_id,version_id),
  FOREIGN KEY(organization_id,runtime_id,project_id) REFERENCES node_content.spaces(organization_id,runtime_id,project_id)
);
CREATE FUNCTION node_content.project_name_at(org uuid,project uuid,allocation uuid,version uuid) RETURNS text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE value text;
BEGIN
  SELECT n.name INTO value FROM node_content.project_name_versions n WHERE n.organization_id=org AND n.project_id=project
    AND n.runtime_id=allocation AND n.version_id=version;
  IF NOT FOUND THEN RAISE EXCEPTION 'selected project name generation is unavailable' USING ERRCODE='55000'; END IF;
  RETURN value;
END $$;
