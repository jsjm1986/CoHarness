---
kind: upgrade-guide
description: "Organization deployment policy replaces environment-only multi-computer forwarding."
---

# Single-computer mode and explicit primary setup

English | [中文](guide.zh.md)

## Change

Migration 101 introduces organization-wide deployment mode. New organizations use local resources while retaining multiple users, Runtimes and collaborative projects. Only the primary aggregates managed computers; secondary Web UIs remain local. `HGW_NODE_SERVICE_FORWARDING` identifies the legacy initializer and cannot override saved policy. Migration 130 distinguishes permanent disaster isolation from ordinary detachment.

## Migration

1. Deploy matching Gateway, Web and Admin assets through the controlled upgrade. Preserve organization/node identities, Runtime UUIDs, private directories and Session generations. Existing managed execution retains lease checks during legacy initialization.
2. At the original forwarding Gateway, retain `HGW_NODE_SERVICE_FORWARDING=on`, open **Admin → Deployment → Deployment mode**, enable multiple computers and confirm a configured origin. Confirm `/account/api/deployment/context` reports `multi`, `primary` and `organization`; secondary entries report `local`. New single-computer deployments need no forwarding setting.
3. Install the reviewed Node Agent service using the [deployment reference](../../../../gateway/docs/deployment-topology/README.md). Match the Gateway account, release and private setup path. Select an existing identity or register a new name, then enter its code at that computer. Prepare database access, encryption keys and allowed origins separately; codes distribute no secrets.
4. Confirm local Runtimes stopped before managed activation. Before disabling aggregation, stop work and transfers and detach ordinary registrations. Detached computers retain identities and data, and start independent generations; re-enabling requires explicit enrollment. Verified permanent disaster isolation also permits closing, but the old identity cannot execute, enroll or become primary. Replacement computers need new identities. Primary-local tasks remain intact.
5. Verify local-only API rejection, invitation permissions, document ownership, independent tabs and lazy startup. Preserve drafts and unsaved settings during mode changes. Restore retains current topology and enrollment authority; older connections cannot revive. Dumps predating migration 102 require an isolated recovery upgrade. Complete backups retain coverage checks.

Deploy matching project-governance assets: model assignments, quotas, usage and contributor requests follow the selected computer. Organization model policies and reports remain shared. Reading these views does not start Runtimes.

Custom assemblies supply topology to routing and catalogs, the Runtime-owned directory, target-aware Workspace creation, matching Connection/Remote libraries and configured `metadataTiming`. Rebuild browser bundles. See the [API reference](../../../../gateway/docs/deployment-topology/README.md#api-reference).

Verify bare `/` login enters Harness at the authorized personal default without an environment chooser or starting other Runtimes. Exact links retain their destinations. Unqualified saved Session references remain unresolved until their original environments are confirmed; removing a pane changes only layout. Workspace keys include the allocation UUID.

Prepared creates may include bounded initial history; older nodes retain the subsequent history read on the returned Session, draft reservation and workspace. Draft IDs resolve on their owning node; revision pins preserve copied-tab text. Unavailable retained revisions leave input in the tab. Apply node-content migration 015 to placed projects; personal draft databases upgrade in place.
