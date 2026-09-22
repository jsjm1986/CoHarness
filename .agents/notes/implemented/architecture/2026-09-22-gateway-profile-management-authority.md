# Agent Note: Gateway authority for profile management

Status: implemented

English | [中文](2026-09-22-gateway-profile-management-authority.zh.md)

## Problem

Profile operations install and execute Host code outside the workspace sandbox. Tool approval expresses consent for one call, but does not establish an organization administrator's authority. Direct Remote callers also bypass tool approval entirely.

## Decision

[Plugin Manager](../../../../packages/boot/plugin-manager/README.md) checks deployment authorization before each public operation and again after entering a queued writer or configuration operation. Its tool checks the same policy before requesting approval. Independent local profiles retain local-operator access; Gateway launch patches require the policy provider, including as a Loader dependency. A missing provider cannot restore local access.

[Gateway Runtime](../../../../packages/context/gateway-runtime/README.md) supplies the provider from its verified request context. Missing, restricted-purpose and expired principals are rejected. The private Gateway API then checks the current active administrator membership, so a valid older assertion cannot preserve a revoked role. Authentication, collaboration, governance and isolation entries are protected from direct toggles and bundle replacement, including patches against their owning entries.

This policy supplements [current-profile management](2026-09-14-current-profile-plugin-management.md); its writer locks, HMR serialization and partial-outcome rules remain in force. The service does not infer authority from model text or historical message authors. An operation without current verified request authority is refused.

## Alternatives considered

**Checking only the administrative page or Remote router.** Tools and direct service consumers still reach the manager. Authorization belongs in the operation that reads or changes the profile.

**Treating Full access or single-call approval as administrator authority.** These control tool execution within a session, not the organization's right to install Host code.

**Trusting the role in a still-valid assertion until expiry.** Queued changes could outlive role revocation. Fresh membership checks preserve the Gateway's current decision.

## Consequences

Managed profile access depends on a reachable Gateway and current administrator identity. Failure is explicit, including when request-local authority is absent. A queued operation rechecks permission before modifying profile files. Local CLI operators retain their existing profile workflow. Tests exercise real Loader-managed profiles, denied service and tool calls, protected bundle patches, missing providers, expired principals and fresh Gateway membership decisions.
