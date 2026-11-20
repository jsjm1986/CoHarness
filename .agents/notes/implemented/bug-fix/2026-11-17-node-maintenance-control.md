# Agent Note: Authenticated node control during maintenance

Status: implemented

English | [中文](2026-11-17-node-maintenance-control.zh.md)

## Problem

The node-agent control lease expires when ordinary maintenance refuses its heartbeat. Losing that lease also loses the authenticated connection needed for remote deployment configuration. Connectivity does not prove that Runtime processes have stopped, so expiring the control lease cannot establish safe writer quiescence.

## Decision

Ordinary maintenance has a dedicated transaction for existing managed nodes' connect, heartbeat and disconnect operations. It holds the organization control row through commit, requires maintenance mode and the calling Gateway's startup write epoch, refuses governance recovery review, and rechecks the primary computer, active organization, current credential and managed attachment. It never promotes pending or detached nodes. Existing connection exclusivity, conditional renewal, successor epochs and exact-generation release remain in force.

Enrollment retains the business write gate. Serving connect retains a business writer because it can promote pending attachment; its transaction reads current serving admission before authority mutations, then initializes and locks the still-serving cluster control row after attachment invalidation and holds that lock through commit. A request carrying an earlier serving verdict refuses attachment after maintenance wins the lock. Maintenance-only connect, heartbeat and disconnect do not enter the business writer count. The shutdown owner refuses new maintenance-control admission, and restoring mode or a changed write epoch prevents the transaction. Normal Runtime execution, account and project authorization remain separate; neither an accepted heartbeat nor a new control connection acknowledges maintenance or modifies Runtime state.

## Alternatives considered

**Exempt all node control URLs from maintenance.** Normal connect can promote a pending attachment. A URL exemption also loses the distinction between ordinary maintenance, restoring and stale Gateway processes.

**Keep leases closed and require direct local administration.** That prevents centralized configuration through the established node-service connection and needlessly expires healthy identities during a maintenance window. It supplies no additional evidence that writers stopped.

**Count maintenance heartbeats as business writers.** Continuous renewal can make an otherwise quiescent deployment appear busy. The control-row transaction already serializes lease changes against restoration; separate Runtime records and maintenance acknowledgements continue to determine quiescence.

## Consequences

Remote administrative control remains reachable during ordinary maintenance without admitting new business execution. Only the maintenance lease path adds the control and recovery checks; serving heartbeat retains its single-statement implementation. A prolonged disconnect can still expire the lease and require a successor epoch, with existing Runtime fencing unchanged. No wire fields, credentials, persisted identities or schema change.

The PostgreSQL HTTP fixture verifies repeated renewals with zero business writer admissions, reconnect retries, refused enrollment and pending attachment, unchanged Runtime records, authenticated execution refusal, revocation while waiting, restoration waiting for lease commit, and both orders of attachment promotion racing maintenance. The keyless assembled transcript runs in the PostgreSQL CI lane. These isolated checks do not establish cross-network deployment availability.
