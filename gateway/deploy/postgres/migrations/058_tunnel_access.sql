-- The public-access tunnel is one supervised cloudflared child per compute
-- node. `desired` records what the administrator asked for so a gateway
-- restart can re-launch it; `state` records what this node last observed.
-- Secret material (the Cloudflare API token and the tunnel run token) is
-- stored AES-256-GCM ciphertext under the node credential key, never as
-- plaintext.
CREATE TABLE harness.tunnel_access (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  node_id uuid NOT NULL,
  mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off','quick','named')),
  desired text NOT NULL DEFAULT 'stopped' CHECK (desired IN ('stopped','running')),
  state text NOT NULL DEFAULT 'stopped' CHECK (state IN ('stopped','starting','running','error')),
  public_url text,
  hostname text,
  domain text,
  zone_id text,
  account_id text,
  tunnel_id text,
  api_token_cipher bytea,
  run_token_cipher bytea,
  last_error text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,node_id),
  FOREIGN KEY (node_id, organization_id) REFERENCES harness.compute_nodes(id, organization_id) ON DELETE CASCADE
);
