# Agent Note: Verify project-name privacy with the deployed database role

Status: implemented

English | [中文](2026-11-17-project-name-privacy-preflight.zh.md)

## Problem

Project names must not enter the governance database's SQL parameter logs. PostgreSQL permits a restricted Gateway role to connect and query management data while denying the parameter settings needed by the name normalizer. Ordinary health checks therefore cannot establish whether project creation can safely normalize a name.

## Decision

The [deployment preflight](../../../../gateway/src/project-name-privacy-main.ts) uses the Gateway's actual connection identity and production normalizer inside a read-only transaction. Its only normalization input is a fixed public value. The operator configures role-and-database logging defaults, or narrowly grants the parameter-setting permission when existing connections need transaction-local protection. [Deployment instructions](../../../../gateway/deploy/node-content/README.md) own those commands.

The check never grants privileges, creates projects or restarts services. Each real request retains its independent logging checks. Diagnostic output excludes connection strings, credentials and canonical bytes.

## Alternatives considered

**Use a superuser health probe.** It can set parameters that the deployed Gateway cannot, so success does not establish readiness for the actual login.

**Remove the per-request protection or grant superuser.** Either weakens the isolation requirement to accommodate a deployment error. Explicit parameter permissions preserve existing business-data authority.

## Consequences

Operators can diagnose the restricted-role failure before accepting project traffic without interrupting long tasks. Passing the check establishes SQL normalization privacy, not storage health or complete project readiness. The runnable CLI transcript covers missing permission, a narrow grant and safe role defaults, including unchanged existing-connection settings and absence of project writes.
