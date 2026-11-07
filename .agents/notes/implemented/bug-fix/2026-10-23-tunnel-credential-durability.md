# Agent Note: Preserve tunnel credentials through encryption and restore

Status: implemented

English | [中文](2026-10-23-tunnel-credential-durability.zh.md)

## Problem

Named tunnels require encrypted Cloudflare credentials that remain decryptable after a database restore. The cipher requested its AES-GCM authentication tag before finalizing encryption, which rejects every real encryption attempt. Orchestration tests substituted an encoding stub for the cipher. The managed-data collector also omitted the independently configured tunnel key, so a database dump could retain ciphertext without its decrypting material.

## Decision

[TunnelCredentialCipher](../../../../gateway/src/postgres/tunnel-access-service.ts) finalizes ciphertext before reading its authentication tag. The persisted byte order remains nonce, authentication tag, ciphertext, and additional authenticated data binds each secret to its organization, node and credential field. Real cryptography tests cover round trips, modified bytes, wrong keys and cross-context reuse; named provisioning also uses the real cipher while external Cloudflare and process operations remain injected.

[Deployment data selection](../../../../gateway/src/postgres/deployment-data.ts) records `HGW_TUNNEL_CREDENTIAL_KEY_FILE` as an independent `gateway-tunnel-credentials` file root, including custom locations. Its bytes follow the selected database snapshot rather than the preserved current node configuration. Restore preview rejects a recorded key location that differs from the configured destination. Credential-location relocation includes this file in byte verification. The [managed tunnel lifecycle](../feature/2026-10-18-admin-managed-public-access-tunnel.md) and [coordinated restoration](../architecture/2026-09-25-gateway-deployment-maintenance.md) retain their existing ownership and maintenance rules.

## Alternatives considered

**Test only the orchestration with a fake cipher.** An encoding stub cannot establish that native AES-GCM completes or that persisted bytes authenticate. The external Cloudflare and process operations stay injected, while encryption remains real.

**Keep the current key during restoration.** Restored database ciphertext belongs to the selected snapshot's key. Retaining an independently replaced current key can make the restored credentials unreadable, so the key is application data alongside its ciphertext.

**Archive the entire Gateway state directory.** That would capture unclaimed files and couple backup coverage to directory placement. An explicit file root covers custom key locations without expanding ownership.

## Consequences

The ciphertext representation and database schema stay unchanged. Complete backups include the tunnel key and verify its copied bytes; restoring it requires the same configured location or an explicit migration. Backups created without the key cannot reconstruct missing secret material. Unit tests exercise actual file collection, snapshots and restoration without a database, and the PostgreSQL backup case captures a custom key with a stored tunnel token. Live Cloudflare provisioning remains outside these deterministic tests.
