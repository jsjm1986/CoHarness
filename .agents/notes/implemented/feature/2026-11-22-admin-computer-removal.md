# Agent Note: Remove unused computer registrations

Status: implemented

English | [中文](2026-11-22-admin-computer-removal.zh.md)

## Problem

Admin can reserve a computer name before deployment. Revoking access and detaching preserve the identity so the computer can resume independent work. An abandoned enrollment still occupies its name and counts toward the organization roster.

## Decision

The [deployment directory](../../../../gateway/docs/deployment-topology/README.md#transitions-and-recovery) reviews one identity and requires a second confirmation. The primary transaction checks administrator authority, serving mode, the reviewed revision, current use and durable bindings. Foreign-key checks include cascades. Locks on the node rows and on ledgers that lack a node foreign key protect the final read. The directory removal and audit event commit together.

## Alternatives considered

**Hide the row in Admin.** A hidden registration would continue to reserve the name and count toward the database roster. The registry entry is removed so those consumers observe the same roster.

**Cascade through dependent records.** Permission, project and recovery references describe data and work the administrator may still need. The review reports these bindings so the administrator can resolve them through their owning controls.

## Consequences

Removal leaves local files and prior audit events intact. Migration 146 keeps the issuance request key while clearing its reference to the removed computer. Retrying the same request yields a conflict and the old code cannot enroll. Reusing the name requires a newly issued identity.
