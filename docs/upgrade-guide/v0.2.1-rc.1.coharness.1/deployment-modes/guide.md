---
kind: upgrade-guide
description: "Organization deployment policy replaces environment-only multi-computer forwarding."
---

# Single-computer mode and explicit primary setup

English | [中文](guide.zh.md)

## Change

Migration101 introduces an organization-wide deployment mode. New organizations default to local resources with the original multi-user, multi-Runtime and collaborative-project behavior. Only the configured primary aggregates managed computers. Direct secondary Web UIs remain local. `HGW_NODE_SERVICE_FORWARDING` identifies the original primary during legacy initialization and cannot override saved policy. Browser metadata comes from the entry Gateway, independently of the selected Runtime.

## Migration

1. Deploy matching Gateway, Web and Admin assets and apply migrations through the existing controlled upgrade. Preserve organization/node identities, Runtime UUIDs, private directories and Session generations. Existing managed execution retains its lease checks while legacy initialization is pending.
2. At the original forwarding Gateway, retain `HGW_NODE_SERVICE_FORWARDING=on`, open **Admin → Deployment → Deployment mode**, enable multiple computers and confirm a configured public origin. Other computers cannot claim that primary. Confirm `/account/api/deployment/context` reports `multi`, `primary` and `organization` at the primary; direct secondary entries report `local`. New single-computer deployments need no forwarding setting.
3. Install the reviewed Node Agent service separately using the [deployment reference](../../../../gateway/docs/deployment-topology/README.md). Match the Gateway OS account, release and private setup path. Select an existing computer identity or pre-register a new name at the primary, then enter its code at that computer’s own Deployment page. Prepare database access, existing encryption keys and allowed origins through the normal deployment procedure; codes distribute none of those secrets.
4. Confirm old local Runtimes stopped before activating managed execution. Before disabling aggregation, stop managed Runtime work and transfers and explicitly detach every registration. Detached computers keep data and identities and start independent work in fresh generations. Re-enabling requires explicit re-enrollment. Primary-local tasks remain intact.
5. Verify local-only API rejection, project invitation permissions, document ownership, two independent tabs and lazy Runtime startup. Confirm mode changes preserve drafts and unsaved settings. Current topology and enrollment authority survive database restore; older connection generations cannot revive. Dumps predating migration102 require an isolated recovery upgrade. Complete multi-computer backups remain subject to the existing coverage refusal.

Deploy matching Admin assets for project governance: project model assignments, quotas, usage and contributor requests retain the selected project computer. Organization model configuration, role/user permissions and organization reports retain their shared scope. Loading these views does not start a Runtime.

Custom Gateway assemblies supply topology policy to HTTP/WebSocket routing and entry-scoped catalog constructors. Custom client connection handles provide `metadataTiming`, resolved from configured readiness and retry limits. See the [API and configuration reference](../../../../gateway/docs/deployment-topology/README.md#api-reference).

Normal login enters the existing Harness UI even when an account has several personal Runtime assignments. Deploy matching Gateway routing and catalog code. Verify the bare `/` entry redirects to the authorized personal default without a mandatory environment chooser or starting other Runtimes; saved exact links must retain their original destinations.

Custom Client compositions must provide the Runtime-owned management directory, target-aware Workspace creation and matching Connection/Remote libraries. Rebuild browser bundles together. Saved layouts with unqualified Session IDs retain their references until original environments are confirmed; removing an unresolved pane changes only its layout. Workspace resource keys include the allocation UUID. No committed Session generation or user file is rewritten.

Upgraded Web clients may request a bounded initial history page with a versioned prepared create. If a node omits the optional page, the client reads history for the returned Session on that node. Its draft reservation and workspace are retained.

Existing draft IDs still read the current value from their owning node. Updated clients pin a revision so a copied tab can recover its text after the original tab edits. A revision predating retained history or outside the configured window is reported unavailable, and input stays in the tab. Apply node-content migration 015 to placed projects. Personal draft databases upgrade in place.
