# Agent Note: Gateway authority for profile management

Status: implemented

English | [中文](2026-09-22-gateway-profile-management-authority.zh.md)

API Remotes mounts the generated Plugin Manager contribution in the actual Client assembly. Plain-Node built-artifact tests cross the real HTTP carrier to verify all eight management methods refuse a denied policy, an authorized inventory read succeeds, and removing the required policy fails closed. General Host event subscriptions do not carry installation logs. The administrative installation stream forwards only its request’s events, rechecks authority for each frame, and waits for package cleanup on cancellation.

## Problem

Profile operations install and execute Host code outside the workspace sandbox. Tool approval expresses consent for one call, but does not establish an organization administrator's authority. Direct Remote callers also bypass tool approval entirely.

## Decision

[Plugin Manager](../../../../packages/boot/plugin-manager/README.md) checks deployment authorization before each public operation and again after entering a queued writer or configuration operation. Its tool checks the same policy before requesting approval. Independent local profiles retain local-operator access; Gateway launch patches require the policy provider, including as a Loader dependency. A missing provider cannot restore local access.

[Gateway Execution](../../../../packages/context/gateway-execution/README.md) owns the provider. An interactive call requires a live ordinary HTTP principal or a purpose-restricted profile-management principal and a fresh Gateway administrator check. Agent-initiated operations instead check the actual Agent's [complete verified participant set](2026-09-22-verified-execution-participants.md); every contributor must retain administrator authority. A valid older assertion, browser role, or inherited asynchronous request context cannot preserve a revoked role. Authentication, execution authority, collaboration, governance and isolation entries are protected from direct toggles and bundle replacement, including patches against their owning entries.

This policy supplements [current-profile management](2026-09-14-current-profile-plugin-management.md); its writer locks, HMR serialization and partial-outcome rules remain in force. The service does not infer authority from model text or historical message authors. An operation without current verified execution or interactive authority is refused.

Install and remove operations accept the calling Tool or Typert transport's cancellation signal and pass it to the owned package-manager process. Installation rechecks authorization after the process settles and before profile activation. Cancellation or lost authorization during installation restores the captured manifest and lockfile; downloaded files may remain. Cancellation after installation has committed but before activation leaves the package installed and inactive, and reports the partial change. Removal retains the manager's explicit partial-outcome rules rather than claiming to undo completed unloads.

## Administrative workflow

The [Admin page](../../../../gateway/admin-ui/src/pages/PluginsPage.tsx) uses the upstream alpha.2 manager controller, page and dictionaries through a transport adapter. Generated Remote codecs validate responses. Selection binds the current node, runtime owner and generation; reads do not start an idle instance. The dedicated signed purpose admits declared profile HTTP endpoints and cannot authorize terminal access or unrelated Remote calls. Its lifetime follows the server-owned operation deadline, while every authority check still reads current membership.

The configuration directory is populated from the selected runtime’s redacted settings description. It uses the same settings provider and revision-fenced path mutation service as the Web settings surface; the administrative adapter only changes authorization and presentation. Fields inherit the registered schema, defaults and application timing. Credentials have explicit retention, replacement and unset actions, and nested edits cannot replace a redacted credential container. Account preference namespaces are excluded. Switching runtime, revocation and generation changes dispose the directory and form; a late response cannot populate the new target. Configuration refresh follows completed inventory changes and window focus instead of duplicating the initial read.

The [installation stream](../../../../packages/boot/plugin-manager/src/install-stream.ts) subscribes before execution, bounds queued UTF-8 bytes and rejects duplicate active request identities. It acknowledges ownership before waiting for the profile writer lock, so cancellation remains available while queued. Connection loss cancels the owned process but does not prove a result to the browser; the adapter does not reconnect or replay installation. A clean final frame and stream completion are both required. Logs remain private to the management request, rather than entering global Host events.

The browser acceptance exercises the built CLI profile, Gateway login and forwarding, real pnpm installation and explicit activation against disposable profile files. It does not substitute for managed PostgreSQL authority or final-candidate platform evidence. Shared primitive behavior and upstream manager interaction tests protect cancellation, script approval, retries and partial outcomes.

The browser gate declares the Admin build after the shared runtime build. Its regional golden belongs to the settings group; explicit source and codec consumers select this group without adding unrelated runtime matrices to an Admin-only change. Standalone Admin CI generates only its two required Remote contributions from locked workspace sources.

## Alternatives considered

**Checking only the administrative page or Remote router.** Tools and direct service consumers still reach the manager. Authorization belongs in the operation that reads or changes the profile.

**Treating Full access or single-call approval as administrator authority.** These control tool execution within a session, not the organization's right to install Host code.

**Trusting the role in a still-valid assertion until expiry.** Queued changes could outlive role revocation. Fresh membership checks preserve the Gateway's current decision.

## Consequences

Managed profile access depends on a reachable Gateway and current administrator authority for the operation's actual initiators. Failure is explicit. A queued operation rechecks permission before modifying profile files, and Tool or transport cancellation reaches the package-manager child. Local CLI operators retain their existing profile workflow. Provider tests establish rejected identities and fresh Gateway membership checks; the manager's real Loader tests own queued-write, cancellation, protected-profile and manifest-restoration evidence.
