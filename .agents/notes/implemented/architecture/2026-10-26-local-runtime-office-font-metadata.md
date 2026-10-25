# Agent Note: Office font metadata across local runtimes

Status: implemented

English | [中文](2026-10-26-local-runtime-office-font-metadata.zh.md)

## Problem

Local Gateway runtimes run under one operating-system account but have separate homes. First Office renders can repeatedly inspect the same system fonts. Three alternating pairs of fresh built-provider processes converting a one-page Latin/CJK DOCX record a median of 2.22 seconds with separate empty caches versus 1.25 seconds with reusable metadata; median Node maximum RSS is 943 versus 287 MiB. The initial shared-cache fill takes 8.59 seconds and remains necessary. A separate kit diagnostic with a larger synthetic DOCX produces identical raster pages across both cache modes. These measurements exclude native-child memory, network and browser rendering; they do not establish the cause of every slow preview.

## Decision

The [Office provider](../../../../packages/document/office-to-pdf/README.md) exposes the installed kit's bounded metadata-cache options. Gateway's local launcher gives runtimes one node-owned directory through their profile configuration. The kit remains responsible for discovery, physical-file identity validation, atomic publication, corrupted-cache recovery and cancellation. Each operation still discovers its own font sources. No original font bytes, document inputs, converted PDFs or authorization results enter this shared cache.

Gateway accepts a deployment-specific directory or `off`. Systemd runtimes retain separate caches because they run under distinct operating-system identities; an explicit shared directory is rejected. The [bounded conversion decision](2026-09-15-bounded-office-conversion.md) continues to own source admission, completed PDFs and engine lifetimes. The [authorized preview decision](2026-09-23-authorized-office-preview.md) continues to own Session access and version checks.

## Alternatives considered

**Share converted PDFs across runtime identities.** This creates another content and authorization owner; derived font metadata avoids that change.

**Keep a native converter resident for every runtime.** This retains engine processes while users are idle. Metadata reuse requires no resident font Worker or native engine.

**Skip source discovery after a cache hit.** This misses changed, added or removed fonts. The kit revalidates the discovered files before reuse.

## Consequences

The first node-wide cache fill still pays inspection cost. Subsequent renders with reusable metadata avoid repeated parsing while preserving source ordering and font matching. Missing, invalid or inaccessible metadata affects performance rather than document availability. The directory is disposable cache data, not a required backup or Session generation. Processes sharing it require equivalent operating-system privileges.

Provider and Gateway tests cover option forwarding, invalid paths, byte bounds, local composition and opt-out. The runnable Office browser scenario uses an explicit metadata directory and a damaged cache, compares its selectable PDF against the existing snapshot, and checks conversion recovery. The package diagnostic measures fresh built-provider processes separately from browser readiness.
