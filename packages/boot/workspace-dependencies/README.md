---
description: "Offline installation of node-local interpreters and document libraries, with explicit execution paths."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-dependencies

English | [中文](README.zh.md)

## Summary

This plugin supplies `load_workspace_dependencies`: a tool that installs a deployment-owned Python, Node.js, pnpm, and document-library payload and returns its absolute paths. It does not operate a desktop, grant computer-use permission, change PATH, or replace Office skills and preview conversion.

## Table of Contents

- [Configuration](#configuration)
- [Installation](#installation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Configuration

Mount the plugin beside `tools` and the filesystem provider. `source` is the absolute bundled payload directory; `root` is an absolute installation directory owned by this runtime. Neither path is model-controlled. Source and destination must not overlap.

```yaml
- name: '@deepseek-ai/dsh-workspace-dependencies'
  config:
    source: /opt/coharness/runtime/primary-runtime
    root: /var/lib/coharness/runtime/primary-runtime
```

The active Agent's filesystem must map host paths into its execution environment. SSH and other unmappable execution targets are refused before installation. Managed deployments retain their existing tool authorization and sandbox policies; this tool grants no desktop, project, or command-execution permission.

## Installation

Build the payload with [the locked builder](../../../scripts/workspace-runtime/prepare.ts), then verify a relocated installation with [the installed-runtime check](../../../scripts/workspace-runtime/verify-installed.ts):

```sh
pnpm run build:workspace-runtime --target mac-arm64 --output .artifacts/workspace-runtime/mac-arm64 --cache .artifacts/workspace-runtime/downloads
pnpm exec tsx scripts/workspace-runtime/verify-installed.ts --source .artifacts/workspace-runtime/mac-arm64
```

Locked targets are `mac-arm64`, `mac-x64`, `win-x64`, `linux-x64`, and `linux-arm64`. Downloads must match their SHA-256 values; Python distribution versions must match the complete wheel inventory. Native builds execute interpreter, package-manager and Office document round trips. A foreign target requires `--cross` and reports `executionVerified: false`; copying its files never supplies platform execution evidence. The builder refuses an existing output directory. Linux wheels require the glibc versions declared by their locked wheel tags.

The [CLI patch](../../../apps/cli/config/workspace-dependencies.cordis.patch.yml) enables the tool in a selected profile. Set `DSH_WORKSPACE_RUNTIME_SOURCE` to the absolute deployment-owned payload directory, and pass this patch to `dsh --profile sdk`, `web`, or `headless`. Its private destination is `workspace-runtime` under the selected Harness home. Inspect the resolved composition with `--dump-config`. Deployment packaging must carry the payload alongside the application; the npm plugin alone contains no interpreters.

The installer checks manifest versions and platform identity, stages a complete copy, and replaces the installed tree under the shared cross-process writer lock. An interrupted replacement can recover its previous tree. Reusing the same manifest preserves user-added packages; the returned distribution versions describe the bundled payload only. No runtime invariant companion is published: installation checks execute at publication, and the tool registry owns registration disposal.

## Model Experience

### Request context and condition

#### What the model sees

The `load_workspace_dependencies` tool returns `python`, `node`, `pnpm`, `pythonPackages`, `nodePackages`, and `pythonDistributions`. Use the returned Node executable to invoke the pnpm script. Loading paths does not execute a user script or prove its output.

#### KV Cache effect

Mounting adds one tool schema. Calling adds its ordinary tool result without a separate system-prompt contribution.

## Known Limitations and Deferred Work

Payload download, platform packaging, and installed interpreter validation belong to the deployment build. The installer does not download missing components or install onto SSH targets. A stale writer lock requires operator investigation; contenders never remove a lock merely because it is old.

## Dev Note

The installer derives from the fixed alpha.2 `desktop-host` implementation. CoHarness uses a plugin usable by its CLI and Gateway runtimes, adds cross-process installation serialization, and rejects paths that the current execution target cannot use. [Office skills](../../skill/skill-office/README.md) supply document workflows; [computer-use](../../computer-use/computer-use/README.md) owns desktop access.
