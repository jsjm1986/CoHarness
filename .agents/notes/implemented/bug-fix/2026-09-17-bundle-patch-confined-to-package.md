# Agent Note: Bundle patch declarations stay inside the package

Status: implemented

English | [中文](2026-09-17-bundle-patch-confined-to-package.zh.md)

## Problem

`loadProfile` joined a bundle's declared `dsh.bundle.patch` straight onto the resolved package directory with no confinement check. An absolute path or a `..`-bearing declaration pointed the composition layer at a file outside the bundle — escaping the package-internal boundary the bundle contract declares, and reading a file the profile author never agreed to compose.

## Decision

The declared patch resolves against the package directory and must stay inside it: an absolute declaration or one whose resolved relative path escapes the package fails loud at profile load, naming the bundle and the offending declaration. Bundle contents are package-internal by contract, so this enforces a boundary the format already promised rather than adding a new restriction.

## Alternatives considered

**Normalize and allow escapes.** Rejected: the declared patch is part of the bundle's own manifest — a bundle reaching outside its package directory is a misconfiguration, and silent acceptance hides it.

**Constrain at bundle authoring time only.** Rejected: profiles compose arbitrary installed packages; the load boundary is where the promise is enforced.

## Consequences

A bundle manifest naming `../anything` or an absolute path fails profile load with a precise error instead of composing a foreign file; every in-tree bundle already declares `./cordis.patch.yml` and is unaffected.

## Verification

`profile.spec.ts` stages a bundle whose `dsh.bundle.patch` is first a `..` path then an absolute path and asserts `loadProfile` rejects both.
