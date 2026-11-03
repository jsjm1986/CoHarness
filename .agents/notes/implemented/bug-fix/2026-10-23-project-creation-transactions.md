# Agent Note: Project creation owns its transaction and directory cleanup

Status: implemented

English | [中文](2026-10-23-project-creation-transactions.zh.md)

## Problem

Project mounts define which host files a shared runtime can access. A directory-overlap check detached from insertion allows concurrent parent and child imports to register both paths. Managed-directory compensation also needs to distinguish an uncommitted insert from a committed project whose response cannot be read. Separately, borrowing another pool connection from an active member transaction can exhaust the entire pool.

## Decision

[PostgresProjectService](../../../../gateway/src/postgres/project-service.ts) checks reserved user paths and existing project mounts with the transaction client after acquiring the node's port-allocation advisory lock. Administrator imports, user-owned creation and steward seeding use this same insertion path. The lock spans the checks and mount insertion; it also serializes creation with the user provisioning that reserves home paths.

Administrator project creation and directory import carry the authenticated creator into the transaction and require a current active organization administrator. Account and membership locks precede node allocation; organization availability is checked after that wait. Rejected authority returns403 before allocating an administrator directory or registering a mount. SQLite checks authority, directory eligibility and insertion in one immediate transaction. An omitted service actor permits trusted internal maintenance.

The insertion operation owns compensation for directories allocated by user-project creation. It permits removal only while its transaction body has not completed. Once that body is ready to commit, a missing commit acknowledgement or failed response-detail query preserves the directory. An ambiguous commit therefore cannot trigger recursive deletion of potentially committed project content.

Project-kind checks accept the caller's query executor. Member changes and project deletion pass their existing transaction client, so each mutation needs only one checked-out connection.

Project deletion retains its project row before reading affected members, so a membership transaction that commits while deletion waits is included in the returned grant-refresh set. SQLite deletion acquires an immediate transaction before capturing the same set. Both providers preserve project files. Membership insertion reports an unknown project when it is absent; PostgreSQL rechecks after waiting for its project lock, without attempting a foreign-key write.

The [deletion lifecycle](2026-10-28-project-deletion-lifecycle.md) owns Runtime stop admission and quiescence. The [managed-directory policy](../feature/2026-08-16-gateway-managed-project-directories.md) and [administrator directory browser](../feature/2026-08-17-gateway-admin-host-directory-browser.md) retain their independent naming, browsing and host-file ownership decisions.

## Alternatives considered

**Check paths before starting the transaction.** Two creators can observe the same empty mount set before either obtains the insertion lock. The overlap decision must remain inside the serialized write.

**Query for the mount after any creation failure and delete an absent directory.** A database failure may also prevent that verification, and a lost commit acknowledgement cannot establish that the transaction rolled back. Retaining uncertain data avoids making a transport failure destructive.

**Let shared helpers borrow from the pool.** Reusing a helper does not justify borrowing a second connection while its caller holds one. Passing the executor preserves the transaction and works with a one-connection pool.

## Consequences

Failed inserts still remove their newly allocated directory when commit is impossible. An unsuccessful or ambiguous commit may leave an unregistered directory for operator review. Imported directories and directories retained by project deletion remain caller-owned.

Real PostgreSQL regressions cover committed response-read failure, lost commit acknowledgement, rollback cleanup and all three affected one-connection mutations. A keyless HTTP snapshot logs in through the real Gateway and blocks two concurrent administrator imports at the node lock; it requires one accepted mount and one overlap refusal without fixing which request wins. These checks use disposable database identities and temporary filesystem roots. They do not measure production database failure rates.
