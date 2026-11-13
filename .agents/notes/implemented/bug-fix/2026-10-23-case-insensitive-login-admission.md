# Agent Note: Case-insensitive PostgreSQL login admission

Status: implemented

English | [中文](2026-10-23-case-insensitive-login-admission.zh.md)

## Problem

PostgreSQL usernames and login-attempt counters use case-insensitive comparisons. Separate Gateways can count failures concurrently when their advisory-lock keys retain different spellings of the same username, weakening the shared five-failure lockout.

## Decision

Both the process-local login queue and the PostgreSQL transaction lock use PostgreSQL's locale-aware lowercase username with the organization identity. A database lookup computes that username before local queue admission. Password verification remains outside the transaction; the locked transition counts failures, revalidates the current identity and credential, and commits the attempted login.

## Alternatives considered

**Use only the process-local queue.** Independent Gateway processes do not share that queue, so they can admit conflicting attempts against the same PostgreSQL counter.

**Keep the submitted spelling in the database lock.** Case-insensitive identities would continue to occupy different lock namespaces.

**Use JavaScript lowercase for both locks.** JavaScript and PostgreSQL can fold Unicode differently. Under the database locale, `clİent` can identify `client` while JavaScript produces `cli̇ent`; those spellings would share a failure counter but occupy different locks.

## Consequences

Case variants share one lockout decision across Gateways, including aliases recognized by PostgreSQL's locale. Each login adds one database query before password verification; database failure refuses admission. [Per-source Gateway login lockout](2026-11-13-per-source-login-lockout.md) scopes that counter to each client source. Real PostgreSQL regressions cover ASCII and locale-dependent aliases against the same shared lock and failure counter.
