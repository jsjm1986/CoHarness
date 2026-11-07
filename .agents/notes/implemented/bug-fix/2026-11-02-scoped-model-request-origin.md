# Agent Note: Scope main requests to their live LLM service

Status: implemented

English | [中文](2026-11-02-scoped-model-request-origin.zh.md)

## Problem

Independent Runtime trees can reuse a Session id and model route in one process. A process-wide request marker lets a foreign request consume another tree's pending title revision. A title trigger that assumes human input precedes `step/start` also misses actual loop input, which enters after that event.

## Decision

Each `LlmRuntime` owns a weak set of exact loop-built requests. Its marker accepts already-frozen objects without mutation; copies and other service instances inherit no marker. Service disposal discards the set and refuses new marks. The dispatching loop service records the exact request, and global LLM waterfall listeners check the emitting service receiver, including isolated providers.

Automatic title work requires a current open step, the logged request route and the pending human message's id in the marked request. Request membership supports input logged before or within the step and excludes delayed older requests. The marker grants no execution, account or billing authority.

The [reconstructable-request decision](../architecture/2026-07-05-reconstructable-requests.md) continues to own logged model input. The [freeze-cache decision](../simplification/2026-09-06-agent-request-freeze-evidence.md) continues to own successful message-freeze evidence; neither rationale is superseded.

## Alternatives considered

**Retain a process-wide request marker or compare Session ids.** Neither distinguishes independent service owners sharing a process and ids.

**Put a marker on the request.** Loop requests are frozen. A copied or serialized field also lacks the exact-object and live-owner semantics.

**Use the listener's construction context.** A global listener can observe an isolated LLM provider; its emitting service owns the request.

**Compare input and step-start sequence numbers.** Real loop input enters within the step. Sequence order cannot prove that a request includes the pending message.

## Consequences

Consumers use the [service methods](../../../../packages/llm/llm/README.md#understand-the-implementation), and external callers follow the [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/model-resource-ownership/guide.md). Weak references retain no old history. Session events, format and SDK wire fields are unchanged.

The [runnable Loader composition](../../../../examples/headless-agent/tests/fixtures/interaction/request-origin/cordis.yml) checks two actual loops sharing a Session id, foreign requests, unchanged headers, frozen objects, copies and withdrawal. Provider tests cover isolated services, both input orders and delayed older requests. These local providers require no real model API.
