# Agent Note: Private PostgreSQL maintenance input

Status: implemented

English | [中文](2026-11-04-private-postgres-maintenance-input.zh.md)

## Problem

Putting a password-bearing database URL in `pg_dump` or `psql` arguments exposes it to process-argument inspection. Moving the URI password directly into PGPASSWORD changes service-file precedence. A password file cannot represent every password accepted by libpq, including line breaks, and a Gateway-local file is unavailable to an arbitrary Docker or SSH execution host.

## Decision

Maintenance commands use a bounded private stdin frame and the native libpq adapter. Direct local clients receive validated resolved options without the password or service selector in argv, and the exact selected password in their explicit child environment. POSIX wrappers consume the frame on the client's execution host, acknowledge its nonce and replace themselves with that client. Gateway admits restore SQL only after acknowledgement and removes the acknowledgement from archive bytes. Offline archive reads carry no connection input. Automatic SQL-client pairing recognizes case-insensitive Windows executable names while still requiring exactly one archive client. The [client reference](../../../../gateway/deploy/postgres/README.md#private-maintenance-connections) owns installation and the protocol.

The deployment connection owns target selection, including defaults; fixed client flags do not supply missing connection fields. Libpq starts and closes an auxiliary connection to resolve service and environment settings. Readiness has a validated configurable deadline. Cancellation joins the local carrier; the existing exact backend lease and independent SQL transaction lock continue to fence detached remote restoration. [Child environment filtering](2026-10-31-postgres-command-environment.md) remains an independent policy.

## Alternatives considered

**Use PGDATABASE for the full URI.** Native clients can treat it as a database name rather than expanding it as their connection input.

**Strip the URI password and set PGPASSWORD.** A service password can override the intended explicit URI credential.

**Use a temporary pgpass file.** Valid passwords with LF cannot be encoded, and a local file does not establish a remote execution-host path.

**Parse connection URLs in JavaScript.** That duplicates libpq's keyword, service and multi-host parsing and precedence.

## Consequences

Maintenance execution hosts require the adapter built against their PostgreSQL client installation. Legacy wrappers must adopt the versioned stdin protocol; normal Gateway and node-agent builds do not require a C toolchain. Passwords remain readable to authorities permitted to inspect child environments. The named guarantee covers the database password in argv; it does not certify TLS private-key secrets or confidentiality from the operating-system administrator. Resolved nonempty TLS key passwords, OAuth client secrets and SCRAM keys are refused until an additional private credential transport is available; they must not be materialized into argv. Physical Windows maintenance acceptance remains separate from POSIX evidence.

## Verification

Keyless command replays exercise the real child pipes. Real disposable PostgreSQL transactions check direct and Docker backup/restore, lease loss and a multiline Unicode password. Native authentication observations compare service, passfile, empty-password, duplicate, keyword and multi-host cases and inspect the actual client PID. The scoped malformed-input checks refuse execution without echoing connection bytes.
