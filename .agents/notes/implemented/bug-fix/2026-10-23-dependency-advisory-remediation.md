# Agent Note: Remediate dependency advisories across runtime and build tools

Status: implemented

English | [中文](2026-10-23-dependency-advisory-remediation.zh.md)

## Problem

The locked dependency graph included vulnerable production YAML parsing and multiple affected build and test packages. The build-only `extract-zip` package also had two path traversal advisories with no published fix.

## Decision

The workspace keeps vendored source pinned and uses a `js-yaml` override to resolve every consumer to 5.5.0, preventing duplicate nominal `Schema` types. Vite resolves to 6.4.5 for VitePress and 8.2.4 for Vite 8 consumers; esbuild resolves to 0.25.0 and uuid to 11.1.1. The web app and website declare the patched Vite 6 line directly. The webserver test fixture uses `selfsigned` 5.5.0, which removes its vulnerable `node-forge` dependency.

The root build removes `extract-zip` and streams ZIP entries through `yauzl`. Extraction rejects traversal and absolute paths, symbolic links, special files, duplicate destinations, paths through non-directories, and unsupported wheel installation schemes. Locked archive digests are still checked before extraction.

## Alternatives considered

**Keep `extract-zip` because runtime archives are hash-locked.** Digest verification binds an archive to the build lock but does not remove the extractor's unsafe path handling. The replacement validates each entry while streaming it to its destination.

**Upgrade only consumers named by the audit.** A patched transitive `js-yaml` release still produced duplicate nominal Schema types alongside newer workspace consumers. A single workspace version keeps production parsing patched and TypeScript types unified.

## Consequences

The website and application builds now use the same patched Vite major. UUID consumers receive the fixed release across their declared older ranges. ZIP extraction supports regular files and directories only; it does not recreate links or special filesystem entries from an archive.

## Verification

The root npm audit and production npm audit against the public registry report zero advisories. [`prepare.spec.ts`](../../../../scripts/primary-runtime/prepare.spec.ts) covers ordinary wheel extraction, streamed large files, unsupported installation paths, symbolic links, traversal, and duplicate paths. The webserver TLS suite and built Web profile test run against the installed `selfsigned` version; website and web app builds validate the patched Vite graph.
