# Agent Note: Project-scoped settings management

Status: implemented

English | [中文](2026-08-28-project-scoped-settings-management.zh.md)

## Problem

Project scope previously treated the entire runtime settings document as read-only, so owners and organization administrators could not manage safe project behavior while ordinary members received no useful explanation of the disabled controls. Account preferences, project policy, model credentials, and server filesystem operations also had different owners but shared one presentation path.

## Decision

Settings registrations declare a logical owner and an explicit project-manager write flag. The Gateway exposes only project-safe namespaces in project scope; project owners and organization administrators may write namespaces marked `projectWrite: manager`, while account, organization, deployment, and unmarked project namespaces remain read-only. Account locale, theme, and busy-Enter preferences use a PostgreSQL account row with revision fencing and lazy migration from the legacy settings file, so they remain writable and private while a project is active.

The user frontend owns the project settings entry point. Every project member can open a project settings panel that identifies the project owner, management status, available capabilities, and the `/admin`-only filesystem boundary. Owner and administrator actions route to the shared Plugins, Agent presets, and Models surfaces; unavailable capabilities and read-only ownership are stated inline rather than represented only by disabled controls. Project Provider profiles and encrypted credentials use a project-keyed PostgreSQL store, the existing Provider editor and schema operations, and a project revision fence. A successful mutation refreshes the project governance policy; project credentials are value-free in browser responses and are writable only through the project API.

Runtime credential requests call the selected governance method through its service object, so project decryption state remains bound during dispatch.

Gateway project routing obtains management authority and theme policy together with current membership. Proxy revalidation uses the same authority read. Loading a full project member directory for every Runtime request multiplies database round trips on remote computers; permission caching instead delays revocation. The authorized projection removes those detail reads while retaining current account, computer, project and membership checks.

The administrator console remains the authority for server directories, mounts, lifecycle, quotas, organization model governance, and membership overrides. Its project detail page shows configuration ownership and a safe link that enters the user frontend in the selected project scope; it does not duplicate project logic settings. Project credentials and policy writes acquire the project configuration lock before provider-row locks, keeping concurrent edits, credential rotation, and deletion ordered.

Manager writes carry the authenticated actor into the owning service transaction. Account and organization-membership share locks precede the project lock, matching membership writers' ordering; the current project owner, organization availability and steward qualification determine admission. Provider and credential mutations acquire the [organization model-configuration lock](../bug-fix/2026-10-29-model-administration-authority.md) before that sequence. Retained account and project locks prevent a role or owner change from invalidating an accepted database mutation before commit. A stale browser view cannot authorize name, theme, Provider or credential changes. Discovery prepares endpoint-matched credentials under the same authority and releases its database connection before the catalog probe. Browser transports always provide the authenticated actor; an omitted service actor permits trusted internal maintenance.

Administrator membership overrides require the current active organization administrator role inside the owning transaction; project ownership does not grant this authority. The target account is retained before acquiring the project lock, preserving serialization with account deletion. Authenticated administrator routes pass their server-selected actor. Typed permission denials return403 and produce a failed-attempt audit; they do not publish membership invalidations or apply directory grants.

## Alternatives considered

**Make every project setting writable to `rw` members.** Directory write access does not imply authority over a shared runtime or credentials, so this would let any contributor change behavior for every member. Explicit namespace ownership keeps the permission grant narrow.

**Keep all project configuration in the runtime settings file.** The runtime file is shared and local to one instance, while project Provider credentials need durable cross-process ownership and encryption. A Gateway project store gives one source of truth without exposing secret values.

**Build a second project-specific Models editor.** Duplicating schema parsing and provider forms would make personal and project compatibility diverge. The project transport adapts to the existing editor and keeps one field and validation vocabulary.

**Put project logic controls in `/admin`.** `/admin` is intentionally a server-resource surface and is not available to ordinary project owners. Routing logic settings through the authenticated user frontend gives owners the same scope and membership checks as the runtime they configure.

## Consequences

Project managers gain narrowly defined runtime, preset, theme, and Provider controls without gaining host path access or arbitrary settings writes. Ordinary members can inspect the same project panel and understand who owns each disabled capability. PostgreSQL deployments need migrations 020 through 022 and an owner-only model-credential key; legacy or fixture hosts without the account/project transports show an explicit unavailable state. The shared editor, revision fences, and policy refresh add cross-surface tests and require future project settings registrations to declare ownership deliberately.
