# Agent Note: PostgreSQL command environment

Status: implemented

English | [中文](2026-10-31-postgres-command-environment.zh.md)

## Problem

Backup, archive inspection, SQL rendering and restoration execute PostgreSQL tools or configured wrappers. Full process-environment inheritance gives those children Gateway configuration, Runtime settings and provider credentials that their database operation does not need.

## Decision

All four command paths use the existing scrubbed Gateway tooling environment. PostgreSQL's configured password, password-file and SSL private-key inputs remain explicit exceptions under `PGPASSWORD`, `PGPASSFILE` and `PGSSLKEY`. Their absence stays absent. Other PostgreSQL connection settings retained by the shared policy remain available. Database connection transport follows the [private maintenance input decision](2026-11-04-private-postgres-maintenance-input.md); process-close ownership remains unchanged.

## Alternatives considered

**Remove every credential-named variable.** Native PostgreSQL clients can legitimately depend on a configured password file or client-certificate key; removing those inputs breaks authenticated maintenance.

**Keep full inheritance for trusted wrappers.** A wrapper's permission to access the selected database does not require model keys or unrelated Gateway authority.

## Consequences

Custom wrappers consume private database input and PostgreSQL configuration without relying on unrelated Harness variables. Keyless source and compiled command replays check all four actual child invocations with configured and absent synthetic database credentials. Separate real PostgreSQL backup and restore suites verify database compatibility. The connection adapter separately owns password transport.
