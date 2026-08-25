# Agent Note: Keep the archive runtime package in the installation dependency closure

Status: implemented

English | [中文](2026-08-26-runtime-archive-package-closure.zh.md)

## Problem

The tree-external model-governance plugin inserts `@deepseek-ai/dsh-archive-gateway` into every runtime profile. A production profile resolves bare plugin names through the dsh installation dependency closure and its flat fallback links. The archive package was not reachable from that closure, so a newly started runtime failed before serving its Web endpoint even though the Gateway and package payloads were present.

## Decision

The base dsh bundle declares `@deepseek-ai/dsh-archive-gateway` as a workspace dependency. The installation linker therefore discovers the package while walking the bundle dependency graph and creates the fallback link used by every profile. The package remains a peer-aware runtime plugin and is not copied into the tree-external governance bundle.

## Alternatives considered

**Add a manual link to each existing runtime home.** Rejected because a new user or project would still fail on its first start, and host state would become part of package resolution.

**Copy the archive package into model-governance during Gateway startup.** Rejected because it would duplicate an installation-owned package and make the tree-external plugin own lifecycle and artifact copying for another package.

**Declare the package only in the Gateway service.** Rejected because the failure occurs in the dsh profile dependency graph, which is resolved independently inside each runtime process.

## Consequences

Production installs that run the normal workspace dependency installation expose the archive package to profile fallback healing before any runtime starts. Existing profiles may be healed on their next restart; no conversation data or Gateway database rows are changed. Removing the dependency would reintroduce a runtime-start failure whenever the governance patch names the archive entry.

## Testing

The existing `healProfilesModuleFallback` suite exercises transitive bundle dependencies. Production verification additionally resolves the built archive package from the installation anchor and starts the affected personal and project runtime probes after the dependency link is healed.
