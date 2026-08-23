# Agent Note: Project default model authorization

Status: implemented

English | [中文](2026-08-24-project-default-model-access.zh.md)

## Problem

Project model authorization was represented only by per-model rows. A newly created project therefore had no rows and could not use organization-managed models until an administrator opened the project and assigned them one by one. That representation also had no way to make an opted-in project follow models added to the organization catalog later.

## Decision

Projects store a `model_access_default_allowed` flag. New projects set the flag to `true`; projects that existed before the migration retain the `false` default. Project policy resolution uses an explicit model row first and the project flag second, so a model-specific `false` row remains a denial exception while an opted-in project automatically authorizes newly added organization-managed, non-archived models. Provider and model enablement still gates the effective route.

The administrator “all” actions switch this project-level mode and remove explicit project rows. “All on” enables catalog following; “all off” records an explicit closed mode. Individual controls write `true` or `false` exceptions when the mode is enabled and remove the row when a closed-mode project is returned to inheritance. Credential resolution uses the same effective rule as policy projection, so default authorization applies to actual organization requests as well as the UI.

The SQLite schema carries the same project flag for migration and import consistency. The running PostgreSQL Gateway remains the project-runtime implementation; personal Provider/model routes remain controlled by the personal BYOK setting and are not enabled by this project flag.

## Alternatives considered

**Insert one allow row for every model at project creation.** Rejected because each new organization model would require a fan-out write or a trigger, and the rows could not distinguish a deliberate “all off” state from an untouched project.

**Change an absent project row to mean allowed.** Rejected because deleting rows is the existing “clear override” operation and would make “all off” impossible to represent without a second, implicit exception system.

**Authorize only user-origin projects.** Rejected because the product policy applies the same default to all newly created projects, regardless of whether an administrator or a user created the project.

**Backfill existing projects.** Rejected because existing administrator decisions must remain intact; the migration gives old rows a closed default and changes only future project creation.

## Consequences

New projects are usable with the organization catalog immediately, and catalog additions become available without per-project maintenance. Administrators can still deny one route or close a project completely. The project access API returns the mode separately from the runtime policy’s always-false global fallback, preserving fail-closed behavior for routes outside the catalog. Existing projects are intentionally unchanged and require an explicit “all on” action to opt in.

## Verification

SQLite schema and project creation tests cover the new column and version 7 upgrade. PostgreSQL migration, project service, project policy, model addition, explicit denial, all-on/all-off, and credential-resolution coverage run in the PostgreSQL suite. Admin UI tests cover effective counts, the follow-catalog label, and denial exceptions.
