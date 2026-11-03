# Agent Note: Browser startup retains its resource owner

Status: implemented

English | [中文](2026-10-31-browser-startup-resource-ownership.zh.md)

## Problem

Lazy browser acquisition spans local-provider activation, temporary profile creation, process admission and Worker readiness. A grant from the initiating accountant does not authorize starting or publishing a browser under a different runtime configuration. Retaining that accountant for every later connection also misattributes fresh reconnects after a cancelled operation. Saving only a successfully connected runtime loses failed reconnect rollback and lets shutdown miss resources still being acquired.

## Decision

The native Stagehand provider captures the exact initiating Agent and original Cordis resource Service before startup waits. A synchronous check accompanies Chromium startup and Worker admission, including independent acquisition. Chromium checks it before subprocess dispatch and after readiness; the Worker checks it before admission, immediately before allocation and after readiness. A changed provider or missing required admission rejects the acquisition. Unused grants return to their original accountant; failed completion transfers a coalesced, retryable cleanup operation through `ResourceAcquisitionCleanupError`.

A failed Worker construction reports uncertain occupation to its original accountant. If that report fails, acquisition retains both failures and a coalesced, retryable report. Attachment ownership remains reserved until its owner completes that cleanup. Acknowledging uncertainty does not report quiescence or release the permit.

A fresh connection after cancellation captures the current accountant. Its existing owned Chromium range keeps its original permit until confirmed termination. Resource grants are never transferred between providers. The provider retains each connection promise, including failed reconnects. A later operation completes any retained rollback before attempting a fresh connection. Shutdown joins the same promise and its cleanup before releasing browser ownership. Ordinary connection failures with completed rollback can be retried directly.

## Alternatives considered

**Resolve admission only after startup preparation.** That authorizes an old request using a provider that never accepted its original acquisition.

**Reuse the first accountant for reconnects.** A new Worker belongs to its own acquisition and must use current admission.

## Consequences

Callers retry refused startup as a fresh acquisition after restoring admission. Worker readiness does not publish an obsolete connection. SDK drainage, uncertain native allocation and externally owned browser reservations retain their existing cleanup obligations. The [provider reference](../../../../packages/experimental/browser-use-stagehand-native/README.md) owns operational behavior.

## Verification

Focused native-Worker and Chromium tests exercise admission, readiness, cancellation and retained completion. A keyless [Loader example](../../../../packages/experimental/browser-use-stagehand-native/tests/fixtures/startup-owner.mjs) uses real Workers and temporary profiles, checks initiating-Session attribution, refuses stale startup and completes fresh retries and reconnects under current admission.

The example also holds uncertainty reporting after failed construction, refuses another Session while the original owner drains and admits it after the report succeeds. Its external fixture compiler handles only three TypeScript modules and retains their original import locations; CommonJS dependencies use Node’s loader. The SDK URL-compatibility fixtures use an explicitly declared userland codec; replay diagnostics remain exact.
