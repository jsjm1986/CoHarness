---
kind: upgrade-guide
description: "PostgreSQL maintenance children inherit database settings without unrelated Harness secrets."
---

# Upgrade PostgreSQL command inheritance

English | [中文](guide.zh.md)

## Change

Backup, verification and restoration children no longer inherit unrelated Gateway, Runtime or credential-named variables. Configured `PGPASSWORD`, `PGPASSFILE` and `PGSSLKEY` inputs remain available for PostgreSQL authentication; unconfigured values remain absent. Explicit database arguments keep their existing behavior.

The retained stderr diagnostic uses an 8 KiB UTF-8 byte ceiling. Oversized ASCII or multibyte output is clipped to a complete prefix; an exact-limit message remains intact.

## Action

Rebuild the Gateway. Update custom PostgreSQL wrappers that read unrelated `HGW_*`, `DSH_*` or model credential variables to consume their explicit arguments and PostgreSQL settings instead. Existing database data and backup formats need no migration. PostgreSQL documents the supported [connection environment variables](https://www.postgresql.org/docs/17/libpq-envars.html).
