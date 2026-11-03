# Agent Note: Account preferences retain current eligibility and retry failed migration

Status: implemented

English | [中文](2026-10-29-account-preference-authority.zh.md)

## Problem

An authenticated account preference request can wait for a database connection or preference row after its account, membership or organization becomes unavailable. Resolving only a nondeleted user id permits disabled accounts and withdrawn memberships to read or change preferences, and classifies deleted accounts as malformed input. Treating every legacy settings read failure as an empty document commits defaults and prevents a later retry from importing the actual settings.

## Decision

The [account authority helper](../../../../gateway/src/postgres/account-authority.ts) retains an active organization, nondeleted active account and active membership with share locks. [Preference reads and writes](../../../../gateway/src/postgres/account-preferences-service.ts) acquire this authority before initializing or locking preference rows, and retain it until commit. The authenticated public id selects the current account UUID and username; cached role, status and browser identity fields confer no authority. Account preferences require no computer execution grant and remain independent of the selected project.

A request whose eligibility was withdrawn before admission rejects with403 without preference initialization, revision advancement or successful-update audit. Accepted database work finishes before a conflicting account withdrawal commits. The existing revision fence still permits only one concurrent first write with the same expected revision. This account rule complements the independent [project-manager settings rule](../feature/2026-08-28-project-scoped-settings-management.md).

Absent legacy files and malformed YAML initialize the documented defaults. Legacy opens use a nonblocking descriptor and reject nonregular files before reading; a FIFO requires no writer to be refused, and the descriptor closes before transaction settlement. Other file-read failures throw a typed unavailable error with the original cause and roll back initialization. The [HTTP owner](../../../../gateway/src/server.ts) logs the cause once and returns503 with a no-store, path-free response. Repairing the file permits the next request to migrate its actual values. Unexpected parser defects propagate rather than being converted into defaults; this follows the same recovery distinction as [model policy credential validation](2026-10-29-model-policy-authority.md).

## Alternatives considered

**Trust the account returned during HTTP authentication.** Connection and row-lock waits can outlive that observation; it does not retain current membership or organization eligibility.

**Re-read the user id only at the final UPDATE.** Reads can already disclose withdrawn account data, and a second lookup can turn a concurrent deletion into an unrelated update failure. A retained identity covers initialization, describe and mutation together.

**Initialize defaults after any migration exception.** A transient storage failure does not prove that no legacy preference exists. Publishing defaults makes the failure permanent because an existing preference row bypasses migration.

## Consequences

Preference JSON fields and database schemas stay unchanged. Custom services retain current account authority throughout their own operations. A403 requires renewed account eligibility; a503 permits retry after storage recovery. Preference transactions hold account locks during a legacy read, so operators must restore unavailable storage rather than treating a default response as evidence of successful migration.

## Verification

Real PostgreSQL checkout gates cover account deletion/disablement, organization disablement and withdrawn memberships for describe and mutate. Preference-row barriers prove that admitted work retains the account until commit. Concurrent initialization and foreign-account cases preserve revision and organization isolation. An actual cyclic settings path fails without publishing a row and migrates after repair. Authenticated Gateway transcripts cover the same failures, identity spoof fields, successful audit ownership and safe503 retry; emitted Gateway replays require no model API.
