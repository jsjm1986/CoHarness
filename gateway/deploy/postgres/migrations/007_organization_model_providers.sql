ALTER TABLE harness.organizations
  ADD COLUMN model_configuration_revision bigint NOT NULL DEFAULT 0 CHECK (model_configuration_revision >= 0);

CREATE TABLE harness.model_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  display_name text NOT NULL,
  driver text NOT NULL DEFAULT 'pi-ai' CHECK (driver IN ('pi-ai')),
  protocol text CHECK (protocol IN ('openai-completions','openai-responses','anthropic-messages')),
  base_url text,
  auth_mode text NOT NULL DEFAULT 'api-key' CHECK (auth_mode IN ('api-key','none')),
  credential_ref text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','enabled','disabled','archived')),
  source text NOT NULL DEFAULT 'managed' CHECK (source IN ('managed','legacy-catalog')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider_key),
  UNIQUE (organization_id, credential_ref),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, provider_key, id),
  CHECK (source = 'legacy-catalog' OR provider_key ~ '^org-[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  CHECK (credential_ref IS NULL OR credential_ref ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  CHECK ((auth_mode = 'api-key' AND credential_ref IS NOT NULL) OR (auth_mode = 'none' AND credential_ref IS NULL)),
  CHECK (status <> 'enabled' OR (
    source = 'managed' AND protocol IS NOT NULL AND base_url IS NOT NULL AND btrim(base_url) <> ''
  ))
);

INSERT INTO harness.model_providers(
  organization_id,provider_key,display_name,auth_mode,status,source
)
SELECT DISTINCT organization_id,provider_key,provider_key,'none','draft','legacy-catalog'
FROM harness.model_catalog;

ALTER TABLE harness.model_catalog
  ADD COLUMN provider_id uuid;

UPDATE harness.model_catalog model
SET provider_id=provider.id
FROM harness.model_providers provider
WHERE provider.organization_id=model.organization_id
  AND provider.provider_key=model.provider_key;

ALTER TABLE harness.model_catalog
  ALTER COLUMN provider_id SET NOT NULL,
  ADD CONSTRAINT model_catalog_provider_fkey
    FOREIGN KEY (organization_id,provider_key,provider_id)
    REFERENCES harness.model_providers(organization_id,provider_key,id);

CREATE TABLE harness.model_project_access (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  model_id uuid NOT NULL,
  allowed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, model_id),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES harness.projects(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (model_id, organization_id)
    REFERENCES harness.model_catalog(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE harness.organization_model_credentials (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  provider_id uuid PRIMARY KEY,
  key_version integer NOT NULL CHECK (key_version > 0),
  nonce bytea NOT NULL,
  ciphertext bytea NOT NULL,
  auth_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (provider_id, organization_id)
    REFERENCES harness.model_providers(id, organization_id) ON DELETE CASCADE,
  CHECK (octet_length(nonce) = 12),
  CHECK (octet_length(ciphertext) > 0),
  CHECK (octet_length(auth_tag) = 16)
);

UPDATE harness.organizations organization
SET model_configuration_revision=1
WHERE EXISTS (
  SELECT 1 FROM harness.model_providers provider WHERE provider.organization_id=organization.id
);
