# Agent Note: User Web startup loads management pages and artwork on demand

Status: implemented

English | [中文](2026-11-19-user-web-startup-artwork-and-layout.zh.md)

## Problem

The initial application combo included both management pages, the complete file-type artwork and two plugin bundles' illustrations in both languages. Android startup profiles also showed synchronous layout reads while the sidebar and composer mounted.

## Decision

The [document manager](../../../../packages/client/ui-documents/README.md) starts preparing its code as soon as the first editable composer has painted. An early click shares the same chunk load. The [plugin manager](../../../../packages/client/ui-plugin-manager/README.md) loads its page code on first open. The document manager starts its file-type artwork when its body opens. Plugin illustrations load for the selected bundle and language. The [page-owned entries](2026-09-23-page-owned-client-entries.md) register their slots and capabilities through the normal startup path. The [client module loader](../../../../packages/client/modules/README.md) resolves shared code from the chunk's own loaded entry.

The [sidebar](../../../../packages/client/ui-sidebar/README.md) publishes its browsing bounds after layout. The [conversation](../../../../packages/client/ui-conversation/README.md) uses the browser's reported dimensions and batches clipping reads across the tool row before it updates flags.

## Alternatives considered

**Delay entire plugin entries.** Their services and slot declarations own contributions from other plugins. Delaying registration would change when those contributions and the initial UI are available.

**Prefetch both pages and all illustrations after startup.** This spends bandwidth for features the user may never open. Selecting the Plugins page overlaps its code fetch with the catalog read.

## Consequences

The first open can show a loading state before a management page is ready. The document picker starts the request on demand when background preparation has yet to begin. A slower first open shows a closable loading dialog. The document list can show generic file icons and plugin details can reserve illustration space while artwork arrives. Browser scenarios check readiness, reuse of the prepared script, retry and dialog focus.
