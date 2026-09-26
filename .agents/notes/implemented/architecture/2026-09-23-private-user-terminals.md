# Agent Note: Private user terminals in managed runtimes

Status: implemented

English | [中文](2026-09-23-private-user-terminals.zh.md)

## Problem

A shared Session can have several authorized participants. Session identity alone cannot isolate each participant's shell, and a browser request assertion expires long before a retained terminal. Administrators need to terminate resources without receiving another user's screen or execution identity.

## Decision

The upstream [terminal controller](../../../../packages/api/terminal-controller/README.md) and [sidebar presentation](../../../../packages/client/ui-sidebar-terminal/README.md) retain their PTY, bounded screen, attachment, idle-reclamation and explicit-close behavior. CoHarness adds creator ownership within each Session. Standalone mode uses the local operator; a managed runtime never falls back to that identity when its policy disappears.

Gateway admission requires user qualification, and project terminals additionally require project authorization and writable membership. Session visibility is checked independently. PostgreSQL grants bind the organization, node, runtime generation, Session, user and qualification revisions. Browser assertions authorize admission but are not retained. The existing invalidation stream revalidates grants; disconnect or revocation stops the owned processes and awaits cleanup. Regranting qualification does not revive an old owner.

Ordinary terminal Remotes operate only on the caller's creator identity. The administrator has two separate operations: minimal process inventory and explicit termination. Their dedicated signed request purpose is restricted to those HTTP endpoints and rechecks the current database role. Inventory and cleanup bind the current node and runtime generation; listing does not start idle runtimes. Administrative responses exclude terminal text, paths, titles and shell arguments. Cleanup failure remains visible and retryable.

Client associations, unfinished closes and shell preferences carry verified account/runtime/Session ownership. An identity change clears screen models and refuses late responses. Cleanup retains its original address. The single right sidebar owns layout, while terminal recovery runs for blank and populated Sessions without creating replacement shells. Read streams use the existing connection's dedicated bounded NDJSON response; malformed frames and business refusals end the stream, and teardown awaits the iterator's cleanup.

The terminal Client plugin mounts its generated Remote namespace through the Gateway's owned contribution effect before creating its models. Disposal releases that namespace with the terminal models. The shared Remote assembly does not import terminal Client code: runtime ownership supplies terminal identity, so importing the terminal back into that assembly would create a dependency cycle.

## Alternatives considered

- **Use Session ACL as terminal ownership:** lets another participant read or write a private shell.
- **Give administrators a creator identity:** exposes private execution and output beyond inventory and termination.
- **Keep the browser assertion with the process:** either expires valid retained work or extends stale authority without revalidation.

## Related decisions

This refines the ownership statement in [user-terminal permissions](2026-09-16-user-terminal-permissions.md). Its distinction between the human shell and Agent sandbox remains in force. Gateway qualification is organizational admission, not a second Agent permission selector. The [Web terminal decision](../feature/2026-09-09-web-sidebar-terminal.md) remains active for process and screen ownership.

## Consequences

A permitted terminal executes with the selected subprocess provider's system-user permissions. Agent approval or Auto eligibility does not grant terminal qualification. Failed termination retains ownership until cleanup succeeds. The administrative page offers qualification controls and metadata-only supervision; it cannot attach to another user's terminal. Native platform and remote execution acceptance remain separate from source-level policy tests.
