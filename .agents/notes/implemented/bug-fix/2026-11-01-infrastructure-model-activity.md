# Agent Note: Runtime model maintenance has independent activity ownership

Status: implemented

English | [中文](2026-11-01-infrastructure-model-activity.zh.md)

## Problem

A title request deliberately selects Runtime infrastructure admission and carries a Session for tracing. Governance could still find that Session’s current Agent and authorize its later execution for billing. The title then acquired another actor’s activity attribution. An unrelated ambient initiator could instead cause an attribution-conflict failure before the title reached admission.

## Decision

For an infrastructure origin, governance uses the explicit Session reference and does not infer an initiator, executing Agent, billing witnesses or legacy participant actor. Default activity is unattributed even while the traced Agent is live. A consumer’s explicit execution identity retains its existing proof checks. Required authority availability, retained service identity and model policy continue to guard dispatch. Ordinary execution keeps its Agent and explicit-Session conflict check.

The resource provider already maps this origin to the Runtime. Governance follows that owner independently of Session liveness and caller scopes. Project usage remains billed to the project; personal usage remains billed to its owner. Project contributor reports count unassigned infrastructure activity separately. Repeated intake retains event deduplication.

## Alternatives considered

**Use the latest executing Agent for a traced Session.** A background task can outlive that execution and find another human’s inputs.

**Use the ambient caller as the maintenance actor.** A title provider can be invoked under an unrelated caller; that presence supplies no billing proof.

**Reject every infrastructure request carrying billing proof.** Existing explicit proof is an intentional caller decision and keeps its current validation. The default inference is the defect.

## Consequences

No policy, usage, SDK wire or Session format changes. Model-visible title inputs and their logged request remain unchanged. Historical records retain their reported attribution. The [execution-owner decision](2026-11-01-model-request-execution.md) still governs execution requests and retained service lifetime.

## Verification

Actual LlmRuntime tests distinguish Session tracing, ambient initiation, expired execution callbacks, copied legacy participants and explicit billing proof. Execution-origin conflicts still refuse dispatch. Runnable SDK compositions mount the real title service, first-prompt provider, governance and outbox; controlled model preparation and quota waits change the execution actor while an ordinary main request remains active. They compare persisted title input, accepted title, resource origins, released permits and usage in TypeScript and Python. Original private governance source and built packages misattribute activity or refuse the title. PostgreSQL accepts the unattributed traced event, charges one project call after duplicate intake, and creates no contributor attribution.
