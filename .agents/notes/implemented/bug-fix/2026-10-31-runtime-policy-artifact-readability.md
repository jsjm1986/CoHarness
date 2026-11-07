# Agent Note: Runtime policy code is readable by its execution account

Status: implemented

English | [中文](2026-10-31-runtime-policy-artifact-readability.zh.md)

## Problem

A root Gateway can copy policy packages into a private project profile with library directories that its assigned Unix account cannot traverse. The files exist and a privileged build check can read them, but the Runtime cannot import model governance or directory guards. Release permissions and inherited directory permissions must not determine whether mandatory policy code loads.

## Decision

`InstanceManager` prepares access on its private staging copy before publishing a policy package. Directories use `0755`, ordinary files `0644`, and files with source execution bits `0755`. The walk accepts regular files and directories; an unexpected entry refuses publication. It covers nested libraries, patches, package manifests and locale metadata. The source release stays unchanged.

The [profile resolution decision](../architecture/2026-10-13-profile-package-refresh-and-manifest-invalidation.md) remains active: it governs package generations and caches, while this note governs filesystem access to published policy copies.

## Alternatives considered

**Relax permissions on the entire Runtime home.** That would expose private data unrelated to executable policy code.

**Run the project as root.** Root access would bypass the intended execution-account isolation.

**Rely on the release directory or process umask.** Copies can inherit different directory permissions and belong to a different UID than the Runtime.

## Consequences

Only the staged package is normalized. The Runtime home, managed inventory, user files, generated policy and credentials retain their existing ownership and private permissions. A readable library does not grant another account access through its private parent directory. This does not replace project ownership preparation or establish readiness when another mandatory plugin fails.

## Verification

Instance regressions publish restricted source libraries with nested code, locale files and executable helpers, and preserve a private Runtime parent. Gateway HTTP transcripts exercise a restrictive umask in an isolated process, start an actual carrier through the public lifecycle, and record published code modes alongside unchanged private modes. The old compiled Gateway fails this transcript. Real Linux acceptance reads the same project’s policy entries under its assigned Unix account and checks plugin activation before model execution.
