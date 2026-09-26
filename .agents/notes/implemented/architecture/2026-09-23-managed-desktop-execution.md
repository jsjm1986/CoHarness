# Agent Note: Enforce deployment authority before desktop driver calls

Status: implemented

English | [中文](2026-09-23-managed-desktop-execution.zh.md)

## Problem

An operating system desktop grant belongs to the Host process, not to every Gateway user. Tool approval and a registered driver do not establish the executing user's desktop qualification, Session confirmation or resource lease.

## Decision

The [computer-use service](../../../../packages/computer-use/computer-use/README.md) wraps the actual driver operation with a deployment-owned policy. Independent local compositions retain the operator's authority. A managed runtime requires both a live Agent and the policy; once observed, managed authority cannot fall back to local access after provider removal.

The native provider calls the policy before its SDK. The installed driver provider uses the MCP transport waterfall for its fixed namespace. An invocation-owned transport signal carries policy cancellation without mutating the original tool execution. Unrelated MCP namespaces delegate normally. A cancelled operation cannot publish a late successful result, even when the driver ignores cancellation until it settles.

The deployment policy owns current qualification, explicit Session confirmation, exclusive resource admission, revocation and awaited cleanup. Absence of that policy denies managed operations. The Gateway execution provider supplies the configured policy; neither adapter nor policy treats a cancelled transport response as proof that operating-system input has drained.

PostgreSQL desktop qualification has separate user and project owners. Migration 032 defaults absent policies to denial and emits changes through the existing access outbox. Administrative saves bind the owner and revision; concurrent edits cannot overwrite each other. The `desktop` execution capability checks every verified actor and requires writable project membership plus the project grant. The administrative form discards responses for an old owner and forces a fresh read after a conflict. Qualification does not replace Session confirmation or lease ownership.

Migration 033 records explicit human confirmation independently for each Session, desktop, node, runtime generation and user. The stored qualification revisions prevent a later regrant from reviving old consent. The private confirmation endpoint requires a verified interactive principal; ordinary model execution and Auto cannot submit it. Authorization checks every recorded actor and the server-owned current node. Withdrawal emits the existing access invalidation. Coordinator operations bind the authenticated runtime generation and actual root workflow, including retries with the same request ID. Runtime credentials and canonical execution actors authorize coordination; an expired browser assertion is not a background identity.

Desktop confirmation is shared within the actual live root Agent ownership tree, including child Agents and PTC calls. The runtime supplies its live owner chain; PostgreSQL verifies each edge against admitted execution inheritance. A historical fork resumed as an independent root supplies no owners and cannot borrow its historical parent confirmation. Every executing actor still needs a matching root confirmation, so adding a participant requires that participant to confirm; other roots and desktops remain isolated.

The configured Gateway policy serializes driver calls within one root and retains its grant while the root, descendants or owned jobs remain active. It validates qualification, confirmation and lease state before each effect and before delivering output, and renews during long operations. Loss cancels the driver. Successful quiescence releases the grant; uncertain driver failure or cancellation marks it stopping without promoting another workflow. Cleanup authenticates the retained exact owner even after qualification withdrawal. The coordinator rejects another root or desktop, and the configured runtime never accepts a caller-chosen node or workflow identifier.

## Alternatives considered

- **Rely on tool approval:** approval does not establish administrator-assigned qualification or desktop ownership.
- **Check only before dispatch:** revocation during an operation could expose a late result and leave the transport running.
- **Change the shared tool execution signal:** the immutable caller identity and cancellation belong to the tool runtime, not an individual MCP policy.

## Related decisions

The [desktop coordination note](2026-09-19-desktop-resource-coordination.md) continues to own resource serialization, fencing and recovery. This execution adapter supplies the native and MCP consumers of deployment policy; it does not replace that coordinator.

## Consequences

Managed profiles need an active desktop policy before their drivers can execute. Real stdio tests observe that denied calls never reach the child and that admitted requests receive cancellation on revocation. Native-provider tests verify rejection before the SDK effect. The Web composer exposes an explicit current-user confirmation dialog, including for blank Sessions. It reads and writes through the Session-authorized API and Gateway controller; stale nodes, failed saves and disconnected transports cannot confirm a new target. Platform GUI acceptance remains a separate obligation. Real PostgreSQL/HTTP tests cover root sharing, forged identities, revocation, queued cancellation and exact-owner cleanup; driver-policy tests observe serialization, late-result rejection and awaited disposal.
