---
description: "Organization deployment modes, browser-entry scope and explicit computer attachment."
---

# Deployment modes and computer connections

English | [中文](README.zh.md)

## Summary

One organization stores its deployment mode, primary computer, primary origin and decimal revision in PostgreSQL. New organizations use single-computer mode. This mode retains multiple users, multiple personal Runtimes and project collaboration. Each project remains on one computer; account/computer permissions and existing Runtime identities remain authoritative.

## Entry scope

| Mode and entry | Accessible resources | Presentation |
| --- | --- | --- |
| Single | Local computer only | Existing personal, Workspace and document layout; no computer labels or choices |
| Multi, primary | Local resources and authorized managed computers | Unified personal entry, computer groups, lightweight identity and project placement |
| Multi, other entry | Local computer only | Current computer identity; no cross-computer selector |

`GET /account/api/deployment/context` returns the browser entry's policy before any Runtime forwarding. Its `entry`, `primary`, `scope`, `role`, `revision` and `refreshAfterMs` describe the Gateway reached by the browser, independently of the selected Runtime. Local entries reject foreign explicit and resolved Runtime, project, document and WebSocket targets. They never substitute local resources. Directories filter visibility before pagination. Computer counts do not decide the mode. Browser fallback icon requests (`GET/HEAD /favicon.ico`) return directly from the Gateway without resolving or starting a Runtime.

Browser documents retain their current selection, drafts and unsaved forms when policy changes. A captured foreign target becomes unavailable. Same-origin tabs exchange only a revision invalidation; they reread policy without exchanging selection or drafts. Visible pages refresh by `HGW_DEPLOYMENT_CONTEXT_REFRESH_MS` (default30000ms) and on focus. Backend checks use current PostgreSQL policy immediately. Entry metadata uses the connection's configured readiness deadline and retry ceiling; reads do not start Runtimes.

## Administration and setup

The Deployment page uses existing Gateway configuration, public-access and service controls. Enable multiple computers at the intended primary and select a configured `HGW_PUBLIC_ORIGINS` address. The primary can run local Runtimes. Every other computer keeps its own Gateway URL and accepts both its own browser origin and the primary origin through existing origin configuration.

Admin project model assignments, project quotas, project usage and member-contribution reports follow the computer selected in that browser document. An explicit primary-computer link uses the selector's named primary option and preserves the link's target. Organization model providers, role/user model permissions, role/user quotas and organization-wide usage remain available at the primary independently of that selection. Reading these settings does not start the project's Runtime.

The Admin deployment page loads entry policy before status and backup snapshots, keeps one status/backup read in flight, skips overlapping periodic ticks and cancels its reads on unmount. Explicit refreshes wait for a subsequent snapshot when a preceding read is pending. Entry mode metadata uses the same account read endpoint as the user interface; configuration mutations retain administrator checks.

1. Deploy the same project release on another computer, using the same organization database and the deployment's existing encryption keys. Provision its local paths and required services through the existing deployment procedure.
2. At the primary, add an already deployed computer or pre-register a new computer name. Reuse its organization/node identity. A one-time code reserves enrollment; it does not change local execution authority.
3. Open that computer's own Deployment page. Enter the primary origin and code under **Connect to primary**. Save its private setup, review allowed origins, save/apply configuration if needed, then start the installed agent service. The generated agent settings bind the expected organization and node; service connections verify Gateway identity and release.
4. Confirm the primary directory reports a connection, then configure computer use grants, capability qualifications and Runtime assignments through existing Admin controls. Project invitations require use permission on the project's fixed computer.

The wizard does not install software or distribute database credentials or master keys. Install the reviewed [Linux unit](../../deploy/harness-node-agent.service) or [macOS LaunchAgent](../../deploy/macos/node-agent.plist) separately, matching the Gateway's OS account, immutable release, `HGW_STATE_ROOT` and `HGW_NODE_CONNECTION_FILE`. Linux uses `harness-node-agent.service` (`HGW_NODE_AGENT_SERVICE`); macOS uses `com.maycran.harness-node-agent` (`HGW_NODE_AGENT_LABEL`, `HGW_LAUNCHD_DOMAIN`). The installed service runs `node lib/node-agent-main.js`. Adjust template paths before loading it. Windows registers the same compiled entry through the [Scheduled Task template](../../deploy/windows/node-agent-task.ps1): the `HarnessNodeAgent` task (`HGW_NODE_AGENT_SERVICE`) runs the agent as SYSTEM at startup with restart on failure, reads the same private setup file and appends its own log. A missing service or origin is reported with preparation steps.

`HGW_NODE_CONNECTION_FILE` defaults to `<HGW_STATE_ROOT>/node-connection.json`. This owner-private file holds a revision, exact node identity, primary origin, loopback Gateway URL, credential-file path and pending code. It is account-private (mode 0600 on macOS/Linux, an ACL limited to the file owner plus SYSTEM and Administrators on Windows), written atomically and cleared of the code after enrollment. Re-enrollment allocates a fresh credential-file path. Codes stay out of URLs, command arguments and browser persistence. The agent needs no database credentials. Existing environment-based agent configuration remains available when no private setup file exists.

## Transitions and recovery

Attachments are `pending`, `managed` or `detached`; the directory distinguishes connected, disconnected and revoked managed credentials. Activation and managed detachment require confirmed stopped Runtime records and no in-flight service transfer. Offline or unknown state is not stop evidence. The primary pauses stream admission while committing detachment, invalidates credentials and leases, and closes the old control connection. Files, computer grants, project membership and Runtime identities remain. A detached computer starts independent work in a fresh generation without the old managed lease. Re-enabling mode never reattaches it.

The primary can disable aggregation only after every retained registration has detached, including cancelled pending enrollment. Mode updates and attachment changes serialize on the organization policy row and compare revisions. Primary-local tasks are unaffected. To move the primary, detach computers, disable at the old primary, enable from the new primary's direct entry and explicitly re-enroll computers. Running primary migration is not supported.

Migration101 retains legacy managed execution while the original forwarding Gateway explicitly initializes its primary identity in Admin. Its existing `HGW_NODE_SERVICE_FORWARDING=on` identifies the eligible legacy initializer; the variable cannot override saved organization policy. User metadata reports that initialization is required. New deployments need no forwarding variable. See the [upgrade guide](../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/deployment-modes/guide.md).

Database restore retains the destination's topology and agent/enrollment records, invalidates connection generations and preserves node-local connection control files outside application-data snapshots. A backup cannot choose a primary, enable aggregation or revive older access. Enrollment records retain the original issuer UUID as history even when that account is absent from restored application data; issuance still requires a current organization administrator. A dump predating migration102 must be upgraded in an isolated recovery deployment before it can replace current application data. Existing complete-backup checks still require every database computer's files; a local bundle cannot prove multi-computer coverage.

## API reference

| Endpoint | Purpose |
| --- | --- |
| `GET/PUT /admin/api/deployment/topology` | Read ingress policy; PUT uses `{ revision, enabled, primaryOrigin? }` |
| `GET /admin/api/deployment/topology/preflight` | Exact blocker count and bounded computer metadata |
| `GET /admin/api/deployment/topology/candidates` | Bounded already deployed identities, optional UUID `cursor` |
| `GET/POST /admin/api/deployment/node-connection` | Credential-free local setup status; POST `save` with `values`, or `start` |
| `POST /admin/api/deployment/nodes/access/<UUID>` | Existing revision-checked actions plus `detach` |

Changes recheck current administrator authority, retain revision checks and write audit records without secrets. Node enrollment and resource permission APIs are in the [node reference](../node-agent/README.md). Independent-deployment import, separate databases, installation automation and additional Windows execution support are outside this configuration.
