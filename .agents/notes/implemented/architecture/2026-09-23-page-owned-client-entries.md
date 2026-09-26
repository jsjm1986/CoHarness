# Agent Note: Page-owned client entry lifecycle

Status: implemented

English | [中文](2026-09-23-page-owned-client-entries.zh.md)

## Problem

Separate boot and hot-reload code created and replaced the same browser Loader entries. Graph snapshots were ignored after startup, so a Host roster change could leave an open page missing plugins or retaining removed entries. Keeping these paths also excluded upstream startup batches and their real-browser validation.

## Decision

Adopt alpha.2 `WebBootGraph.batches` and `ClientEntries` in [client/modules](../../../../packages/client/modules/README.md). The Host builds immutable bootstrap and application resources with their revisions. One page controller creates initial entries, reconciles later graphs, retries failures, and replaces rebuilt code. Generation checks reject stale downloads; replacement drains old fibers and owned styles before activating successors.

The [Web kernel](../../../../packages/client/web/README.md) retains CoHarness platform seeds, runtime preloading, AbortSignal compatibility, and authenticated composition. Creating the module system before Cordis does not require a second entry owner: `bootClient` hands the real Loader to that same controller. Its status is a bare observable value with an explicit structural type, avoiding a dependency from bootstrap machinery into the Workbench runtime solely for a type declaration.

[Client HMR](../../../../packages/client/hmr/README.md) forwards validated transport frames to the controller. The [plugin inventory](../../../../packages/client/ui-settings-plugin-inventory/README.md) reads its status through a framework-bound hook and retries only the current page. Host enablement, account and project authority, and other browser pages remain independent. The local preset grouping and search stay in place.

Production graph transport remains enabled while artifact polling follows the [explicit development setting](2026-08-23-production-client-hmr-opt-in.md). This preserves live membership changes without adding periodic filesystem work.

The served HTTP carrier supports escaped advisory script preloads. Its existing readiness tail remains authoritative; a preload never counts as script execution or successful activation.

## Alternatives considered

**Keep separate boot and HMR owners.** Both would need the same roster, replacement, retry, and teardown rules, increasing drift and allowing stale arrivals to reactivate removed entries.

**Replace the Workbench to adopt the module loader.** Layout and Session ownership are independent of module arrival and Loader entry lifecycle. Their replacement is unnecessary for this upstream behavior.

## Consequences

Upstream entry and transport tests run against the adopted implementation. Local shell and inventory tests protect the retained adapters; real-browser scenarios exercise roster changes, retries, concurrent pages, and default-product isolation. These checks establish startup and module lifecycle behavior, not completion of Session-reference, right-sidebar, or release acceptance work.
