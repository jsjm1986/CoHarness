# Agent Note: Independent model search retains admission until HTTP dispatch

Status: implemented

English | [中文](2026-10-31-model-search-dispatch-ownership.zh.md)

## Problem

Independent Messages and Sonar search can wait for model capacity and then for credentials. Retaining only the granted permit does not establish that its provider still owns the request. Checking model-policy requirements before credential resolution also permits raw HTTP after that composition requires governed routing.

## Decision

`registerModelSearch()` captures the initiating resource provider and Session before admission. Its synchronous ownership check compares original Cordis Service identities and requires independent routing to remain authorized. It runs after admission and is passed to `ModelSearchImplementation.independent` for checks after asynchronous preparation. Both native providers invoke it before and after secret-free request recording, immediately before their existing HTTP entry point. A changed owner or newly required policy rejects the old request and returns its unused permit through the original provider.

## Alternatives considered

**Look up a replacement provider after waiting.** The replacement did not accept the original request and cannot inherit its grant.

**Check only after model admission.** Credential resolution introduces another asynchronous wait before HTTP.

**Restore independent dispatch when policy is missing.** A required user policy must deny the request until restored, including a default model route.

## Consequences

Callers restore admission or authorization and retry with a fresh search. Successful governed and independent results, Session request fields, credentials and configured model defaults remain unchanged. A recording callback can still refuse dispatch; a recorded attempt remains reconstructable. The [LLM ownership guide](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/model-resource-ownership/guide.md) owns ordinary and prepared model streams rather than these independent transports.

## Verification

Both provider suites cover resource withdrawal, replacement, newly installed admission and policy installation during queued admission or credential resolution. Native governed operations cover initiating-Session attribution and missing required user policy. A real Loader/Agent/file-credential [example](../../../../packages/web/web/tests/fixtures/model-search-owner.mjs) sends only local HTTP, verifies refused requests produce no dispatch or request event, preserves original grants, and completes fresh retries without logging secrets.
