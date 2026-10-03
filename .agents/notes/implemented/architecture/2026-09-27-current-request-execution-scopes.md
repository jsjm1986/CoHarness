# Agent Note: Current-request execution scopes

Status: implemented

English | [中文](2026-09-27-current-request-execution-scopes.zh.md)

## Problem

A shared Session can contain many independent human requests. Using every historical contributor as the authority for each request prevents a qualified user from using Auto after an unrelated ordinary participant. Replacing that set with only the latest visible author also fails: edits, answers, child work, and delayed callbacks can contain several actual contributors, and old work must not borrow a newer user's privilege.

## Decision

[Execution Authority](../../../../packages/context/execution-authority/README.md) distinguishes immutable input witnesses, immutable execution scopes, and current permission checks. The [Gateway](../../../../gateway/deploy/postgres/migrations/047_execution_scopes.sql) owns each scope's runtime, Session, input set, primary actor, and uncertainty. Scope references carry no permission. Historical input witnesses remain available for audit and delayed usage attribution.

A fresh root turn begins with its admitted input. Inputs admitted into the same executing turn combine their participants, including earlier editors. An owned child's direct human input retains its inherited execution; an explicit new delegation carries its own captured source. Selecting Auto checks the live selector, and execution independently checks every actual participant. Unknown current input denies privilege, while unrelated unknown history does not prohibit a fresh verified root request.

Tool calls retain the registry’s opaque parent token. Pre-dispatch Auto checks use that token even when their listener runs before another execution wrapper. Workflow callbacks capture their source before crossing the worker boundary. Jobs retain their source for active work and automatic completion notices. A new request reads terminal job output as historical data without inheriting its former actor. Team messages persist captured scopes with their durable delivery. Late execution results cannot replace another current request.

Remote invocation binds human execution only after authorization and all Agent lookups finish. The shared Remote policy requires each mutation to declare whether dispatch, the operation, or neither owns execution attribution. Goal activation records its verified initiator for subsequent automatic rounds; status, pause, clear, and interruption do not create a new execution. A nested command preserves its captured root or child chain. Questions capture the asking operation; an answer adds its verified responder to that operation, including concurrent answers, without rewriting a newer request's identity.

The required `gateway/scoped-execution` admission marker precedes modern scope storage or exposure, including inherited scopes, relays, and direct commands. An old reader must reject it instead of interpreting a narrowed scope as Session-wide accumulation. `gateway/continuation` separately records automatic execution origins; neither event changes the structural format. A new reader rejects scoped records missing their marker. Legacy accumulated records remain readable and restrictive; a fresh attested root request establishes an explicit scope. A legacy child without verifiable inheritance remains readable but cannot resume by accepting a new caller as a root. A valid captured parent witness can restore its delegated scope. A legacy question cannot overwrite a newer scoped request. Missing scope records, unavailable authorization updates, revoked qualification, or lost lifecycle ownership fail closed.

This partially supersedes the Session-wide authorization lifetime in [verified execution participants](2026-09-22-verified-execution-participants.md). That note's attestation, edit preservation, transport independence, and deployment-isolation rationale remain active.

## Alternatives considered

**Keep all historical actors in every authorization.** This confuses transcript history with the current execution chain and blocks valid independent requests.

**Authorize only the primary actor.** The primary actor supplies billing attribution; it cannot erase editors, responders, or inherited participants.

**Use the current Session when a callback arrives.** A background result can arrive after another user's request. Captured immutable references preserve its real origin.

**Reuse the HTTP asynchronous context.** Request lifetime and delegated work differ. Explicit operation scopes survive transport completion without preserving a browser permission grant.

## Consequences

Each capability check still reads current account and Session permissions. Scopes preserve origin, not a cached allow decision. An active old job can be revoked even while the same Session has a qualified newer request. Cancellation retains the existing owned-resource drainage requirements.

Scope rows and input witnesses survive subsequent requests for audit. Identical scope construction is idempotent. Source and artifact imports use the same type definitions; generated consumer catalogs must include the execution methods and scope fields.

Against upstream `dsh-v0.1.6-alpha.2`, `jobs/jobs/src/types.ts` adds only the type import and optional `JobSnapshot.executionScope` field, which carries the job's captured scope to managed completion consumers. The local registry captures that field and active-work consumers verify it; independent local profiles leave it absent. Upstream Jobs ownership, state transitions, wait, and cancellation remain authoritative. An upstream change to those producers or consumers requires replaying delayed completion and actor-specific revocation regressions.

## Testing

Real Gateway HTTP and PostgreSQL tests distinguish a fresh qualified request from an unqualified historical participant, preserve current editors, reject reduced or foreign inheritance, and bind delayed children and question answers to their original scopes. A Loader-composed Agent transcript exercises denied and permitted tool effects and verifies the resulting file. Source regressions cover nested PTC identity, worker callbacks, job origins, revocation, and cold scope reads. These tests do not substitute for final deployed acceptance.
