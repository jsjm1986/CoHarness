-- Project-owned model routes are separate from the organization catalog.  A
-- project may use organization routes and add private routes without making
-- either the route metadata or its credential visible to another project.
ALTER TABLE harness.projects
  ADD COLUMN project_model_configuration_revision bigint NOT NULL DEFAULT 0
    CHECK (project_model_configuration_revision >= 0);

CREATE TABLE harness.project_model_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  provider_key text NOT NULL,
  display_name text NOT NULL,
  driver text NOT NULL DEFAULT 'pi-ai' CHECK (driver IN ('pi-ai')),
  protocol text CHECK (protocol IN ('openai-completions','openai-responses','anthropic-messages')),
  base_url text,
  auth_mode text NOT NULL DEFAULT 'none' CHECK (auth_mode IN ('api-key','none')),
  credential_ref text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','enabled','disabled','archived')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  profile jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profile) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, provider_key),
  UNIQUE (id, project_id),
  UNIQUE (project_id, credential_ref),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES harness.projects(id, organization_id) ON DELETE CASCADE,
  CHECK (provider_key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  CHECK (credential_ref IS NULL OR credential_ref ~ '^DSH_PROJECT_[0-9]+_[A-Z0-9_]+$'),
  CHECK ((auth_mode = 'api-key' AND credential_ref IS NOT NULL)
    OR (auth_mode = 'none' AND credential_ref IS NULL)),
  CHECK (status <> 'enabled' OR (
    protocol IS NOT NULL AND base_url IS NOT NULL AND btrim(base_url) <> ''
  ))
);

CREATE INDEX project_model_providers_active
  ON harness.project_model_providers(project_id, status)
  WHERE status <> 'archived';

CREATE TABLE harness.project_model_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  provider_key text NOT NULL,
  model_key text NOT NULL,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, provider_key, model_key),
  UNIQUE (id, project_id),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES harness.projects(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id, project_id)
    REFERENCES harness.project_model_providers(id, project_id) ON DELETE CASCADE
);

CREATE INDEX project_model_catalog_enabled
  ON harness.project_model_catalog(project_id, provider_id)
  WHERE enabled;

CREATE TABLE harness.project_model_credentials (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  provider_id uuid PRIMARY KEY,
  key_version integer NOT NULL CHECK (key_version > 0),
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES harness.projects(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id, project_id)
    REFERENCES harness.project_model_providers(id, project_id) ON DELETE CASCADE,
  CHECK (octet_length(nonce) = 12),
  CHECK (octet_length(ciphertext) > 0),
  CHECK (octet_length(auth_tag) = 16)
);
