---
kind: upgrade-guide
description: PostgreSQL maintenance clients require a native private-input adapter instead of a password-bearing connection argument.
---
# PostgreSQL maintenance connection input

English | [中文](guide.zh.md)

## Change

Gateway backups and `pg:deploy` pass database connections through private stdin. Direct `pg_dump` and `psql` commands need the native local resolver; custom Docker or SSH wrappers need the adapter on their execution host. Legacy wrappers receiving `--dbname <URL>` are incompatible. The built-in adapter also refuses nonempty TLS key passwords, OAuth client secrets and SCRAM keys, which need a separate private credential transport. The deployment connection resolves all target settings and defaults, so fixed client flags cannot supply missing connection fields.

## Migration

1. Install the PostgreSQL client installation's libpq headers, development library and a C compiler on each maintenance execution host. After building Gateway dependencies, run `npm run build:pg-client -- --pg-config /path/to/postgres/bin/pg_config` from `gateway/`. Plain Gateway and node-agent builds do not require this optional maintenance component.
2. Keep direct local client commands or configure `HGW_PG_CONNECTION_COMMAND` for a custom local resolver. Put host, port, account and database selection in the deployment connection value. Use `HGW_PG_CONNECTION_TIMEOUT_MS` when the default `30000` ms resolution/readiness budget is insufficient.
3. Install the adapter with its PostgreSQL clients inside Docker or on the SSH host. Insert its executable before `pg_dump`, `pg_restore` and any explicit `HGW_PSQL_COMMAND` client; preserve binary stdin/stdout and disable pseudo-terminals. See the [client reference](../../../../gateway/deploy/postgres/README.md#private-maintenance-connections) for exact framing, environment forwarding and pairing.
4. Confirm the adapter prints `hgw-pg-client/1` with `--protocol-version`. In a disposable deployment, create and verify a backup and complete a coordinated restore. Inspect the actual client arguments to confirm that the database password is absent; confirm cancellation leaves the destination fenced until SQL and file reconciliation finish.
