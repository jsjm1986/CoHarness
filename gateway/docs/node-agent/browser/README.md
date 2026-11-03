---
description: "Computer identity, document locations and exact Runtime actions in the shared browser and Admin."
---

# Browser environments and document locations

English | [中文](README.zh.md)

## Summary

The workbench and Admin follow the browser entry’s [deployment mode](../../deployment-topology/README.md). Single-computer entries retain the existing layout without computer labels. A multi-computer primary offers unified personal browsing and lightweight computer identity; direct secondary entries remain local. A new tab works independently on another computer or Runtime.

## Identity and permissions

| Resource | Identity and permission scope |
| --- | --- |
| Account | Organization account; existing roles and model budgets remain shared |
| Personal Runtime | Allocation UUID; independent Sessions, plugin state and process generation |
| Personal documents | Account and computer; shared by that account's Runtimes on the same computer |
| Project | One fixed computer; membership and computer use permission are both required |
| Capability qualification | Existing subject and selected computer; Session consent remains separate |
| Physical desktop | Computer and actual desktop; independent computers can operate concurrently |

Computer cards display the current computer and exact Runtime. Their environment list contains authorized allocations and loads bounded pages. A display name does not participate in identity. Browser Session keys include the allocation UUID, so equal Session ids from different personal Runtimes stay distinct. Explicit Runtime addresses override legacy scope cookies. Tab-local selection, workspace reservations and workbench presentation keep separate storage ownership; existing Session files are unchanged.

## User navigation

The personal/project selector, conversations and workspaces retain their existing behavior. The computer card offers another authorized environment and an action to open the current environment in a new tab. Switching does not update another tab's Runtime selection. New browser requests, sockets, private links and bootstrap assets retain the selected allocation. Plugin module query bytes survive routing unchanged.

The document manager has one entry and separate computer-local locations. Its header identifies the storage computer and, in the details card, the current conversation's computer. Browsing another location leaves the conversation unchanged. The all-accessible overview reads authorized database metadata; opening a location requests its files on demand. Mixed-location rows carry computer cards. A scoped list identifies its computer once in the header.

Copy plans capture source and destination computers and scopes. Previews read only the selected files' metadata. Commit rechecks both permissions and streams a verified snapshot through the existing resumable upload protocol. The copy receives its own document identity and retains source lineage. Copying or reading documents does not start a Runtime. Personal document access requires a retained account home on that computer; a computer use grant alone creates no storage. Revocation hides the computer's metadata and refuses its content and subsequent writes. An unavailable location reports its own failure; it never selects another computer's identically named file.

## Admin navigation

The Admin computer card retains the current page when changing computers. User details list computer use grants, account-wide Runtime assignments and effective allocation limits. Organization defaults are in Deployment; user overrides are in user details. Allocation retries retain their request id. Lifecycle confirmations identify the computer, Runtime UUID and displayed generation. Plugin, terminal and Webhook execution selectors identify a specific Runtime; plugin configuration and terminal cleanup keep that identity through completion. The project-settings shortcut opens the project's assigned environment.

The existing six qualification controls apply to the selected management computer. Account roles, memberships and organization settings retain their existing shared meaning. Administrators can manage another account's allocations without borrowing that account's personal execution permission; opening a user workbench still requires the administrator's own computer access.

Account choices, account edits, password resets, organization models, usage and budgets are requested from the center. Selecting an unavailable computer does not redirect these shared operations. Instance columns, computer profiles, projects and local resources remain bound to the selected computer.

Mobile Runtime management uses the existing item-list layout with every lifecycle action directly available. Runtime limits sit in a separate disclosure. Failed or unconfirmed writes retain the last displayed grants and quota fields; refresh their authoritative state before another write. Lifecycle failures remain visible inside their confirmation dialog. Refreshing metadata never replays a mutation.

Workbench and Admin links retain their local destination through sign-in and required password setup. The account forms carry `returnTo`; the Gateway accepts only local workbench and Admin UI addresses and rejects external destinations and API routes.

## Browser API

`GET /account/api/document-locations` returns one bounded `items` page and `nextCursor`, without starting a Runtime or inspecting files. `GET /account/api/documents/overview` returns authorized metadata across computers. Browser copy, plan, commit, retry and directory operations use `/account/api/documents/transfer/...`. File operations retain the existing `/api/documents/scope` and resumable upload routes with explicit `scope` and `dshNode`. These browser operations authenticate the account directly and mint no execution principal. Runtime callbacks retain their existing credential and participation checks.
