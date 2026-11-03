# Agent Note: Native model operations retain ordinary model policy

Status: implemented

English | [中文](2026-10-24-prepared-model-operations.zh.md)

## Problem

An auxiliary provider can issue a complete model request through a private protocol. A resource permit alone does not supply model-route authorization, durable request checkpoints, execution attribution or usage reporting. Reimplementing each of those in every Consumer creates different policy paths for the same model capacity.

## Decision

`LlmOperationMap` declares operation parameters, exact secret-free request and result. A captured `PreparedAdapterCall.operations` factory prepares the operation using the same model metadata and connection generation as an ordinary call. `LlmRuntime.prepareOperation()` publishes a detached frozen request. The Consumer records that request before invoking its once-only `run()`.

Execution uses the ordinary `llm/stream` middleware, model permit and final `llm/pre-dispatch` checks. `GenerateOptions.operation` carries the operation name and request; conversation messages are empty. Ordinary dispatch cannot accept an operation descriptor, and a prepared call cannot substitute another descriptor or config.

Physical model streams capture resource ownership before middleware runs. Preparation, queued admission, authorization and the guarded HTTP callback require the same live provider, including the original managed requirement. Withdrawal or replacement returns `RESOURCE_BUDGET_UNAVAILABLE`; a granted permit is returned to its original owner. Fresh Cordis tracing proxies retain the underlying Service identity. Orchestration turns capture no model permit, and each nested physical request owns its own admission. Moving an old request to a replacement provider would mix its pending admission with another owner's capacity.

The adapter reports actual cumulative usage before its terminal outcome, including usage available before a later failure. Missing usage remains missing. Middleware may refuse the call, but a successful terminal marker without an executed operation result cannot create success. Provider rejection and cancellation use the existing terminal failure protocol and resource cleanup.

The web capability owns one `registerModelSearch()` lifecycle for Messages and Sonar Consumers. An installed or required model policy selects a prepared LLM operation, while independent transport acquires its own model permit. A policy appearing during that independent wait refuses the request instead of changing transport after admission. Both protocols record their exact input and preserve credential ownership; cancellation observes late credential settlement and joins transport cleanup.

## Alternatives considered

**Give every auxiliary transport its own authorization and billing wrapper.** Separate implementations can disagree about a queued revocation, credential ownership or the input witnesses that incurred cost.

**Choose another transport after resolving model metadata.** The request could combine one generation's capabilities with another generation's endpoint or credential reference.

**Treat a terminal marker as the operation result.** A middleware short circuit can end a stream without ever executing the operation. The caller needs the adapter's actual result.

## Consequences

Operations remain adapter capabilities with explicit unsupported errors. Consumers retain responsibility for recording their exact request; adapter factories prepare without dispatching HTTP. A prepared operation preserves the ordinary call's configuration validation and cannot be reused. Typed module augmentation supplies the operation vocabulary without process-global registries or hidden callbacks in serialized requests.

## Verification

Focused cases cover captured generations, frozen input, queued policy revocation, permit cleanup after cancellation, actual usage before provider failure, missing usage, missing results, once-only execution and refusal of operation descriptors in ordinary calls. Native search composition verifies the actual API-key route, credential file, HTTP request and governance outbox, including queued route, execution and policy-owner revocation. Source and built TypeScript SDK flows and the Python SDK execute the real web tool with the Messages and Sonar chat-completions adapters, verify persisted input before loopback HTTP and resume in a fresh process. These fixtures do not establish paid external-provider behavior or full Gateway admission and PostgreSQL accounting.

A keyless Loader application replaces or withdraws resource providers during admission and a credential wait, asserting that no loopback HTTP is sent and the original grant is released. Unit cases also cover middleware, preparation and authorization waits, live traced Services, managed requirement changes and fresh nested admissions after orchestration waits.
