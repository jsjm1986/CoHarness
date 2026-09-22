# Agent Note: Gateway authority for profile management

Status: implemented

English | [中文](2026-09-22-gateway-profile-management-authority.zh.md)

## Problem

Profile operations install and execute Host code outside the workspace sandbox. Tool approval expresses consent for one call, but does not establish an organization administrator's authority. Direct Remote callers also bypass tool approval entirely.

## Decision

[Plugin Manager](../../../../packages/boot/plugin-manager/README.md) checks deployment authorization before each public operation and again after entering a queued writer or configuration operation. Its tool checks the same policy before requesting approval. Independent local profiles retain local-operator access; Gateway launch patches require the policy provider, including as a Loader dependency. A missing provider cannot restore local access.

[Gateway Execution](../../../../packages/context/gateway-execution/README.md) owns the provider. An interactive call requires a live, unrestricted HTTP principal and a fresh Gateway administrator check. Agent-initiated operations instead check the actual Agent's [complete verified participant set](2026-09-22-verified-execution-participants.md); every contributor must retain administrator authority. A valid older assertion, browser role, or inherited asynchronous request context cannot preserve a revoked role. Authentication, execution authority, collaboration, governance and isolation entries are protected from direct toggles and bundle replacement, including patches against their owning entries.

This policy supplements [current-profile management](2026-09-14-current-profile-plugin-management.md); its writer locks, HMR serialization and partial-outcome rules remain in force. The service does not infer authority from model text or historical message authors. An operation without current verified execution or interactive authority is refused.

Install and remove operations accept the calling Tool or Typert transport's cancellation signal and pass it to the owned package-manager process. Installation rechecks authorization after the process settles and before profile activation. Cancellation or lost authorization during installation restores the captured manifest and lockfile; downloaded files may remain. Removal retains the manager's explicit partial-outcome rules rather than claiming to undo completed unloads.

## Alternatives considered

**Checking only the administrative page or Remote router.** Tools and direct service consumers still reach the manager. Authorization belongs in the operation that reads or changes the profile.

**Treating Full access or single-call approval as administrator authority.** These control tool execution within a session, not the organization's right to install Host code.

**Trusting the role in a still-valid assertion until expiry.** Queued changes could outlive role revocation. Fresh membership checks preserve the Gateway's current decision.

## Consequences

Managed profile access depends on a reachable Gateway and current administrator authority for the operation's actual initiators. Failure is explicit. A queued operation rechecks permission before modifying profile files, and Tool or transport cancellation reaches the package-manager child. Local CLI operators retain their existing profile workflow. Provider tests establish rejected identities and fresh Gateway membership checks; the manager's real Loader tests own queued-write, cancellation, protected-profile and manifest-restoration evidence.
