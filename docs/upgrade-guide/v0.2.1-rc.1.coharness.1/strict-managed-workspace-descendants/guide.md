---
kind: upgrade-guide
description: Managed project and steward workspace directories must be strict children rather than their configured parent itself.
---
# Managed workspace containment

English | [中文](guide.zh.md)

## Change

Gateway refuses a managed project directory equal to its data root and a steward workspace equal to its steward root, including normalized equivalent paths. Configurations accepted through the empty-relative-path comparison fail at startup. `HGW_PROJECT_PATH_ROOTS` also refuses Windows drive and share roots and accepts independent directories on different volumes.

## Migration

1. For systemd project directories, keep `HGW_PROJECTS_ROOT` and `HGW_USER_PROJECTS_ROOT` in separate strict children of `HGW_PROJECT_PATH_ROOTS`.
2. When steward mode is enabled, select a strict child of `HGW_STEWARD_ROOT` with `HGW_STEWARD_WORKSPACE`, such as its default `workspace` child. Move existing data through the deployment's controlled data migration before changing active paths.
3. Load the resulting Gateway configuration and confirm startup accepts the child paths. Selecting the parent itself must fail before any Runtime starts. Existing reserved-directory and account-permission checks still apply.
4. On Windows, select data directories such as `C:\\project-data` rather than `C:\\` or a share root. Separate volumes may supply independent data directories; nested or equivalent directories remain invalid.
