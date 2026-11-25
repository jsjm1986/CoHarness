# Agent Note: Harden Web e2e readiness waits and capture start replies through routing

Status: implemented

English | [中文](2026-11-25-web-e2e-contention-hardening.zh.md)

## Problem

Two independent Web e2e failure classes surfaced once the `web verification` lane could complete its inventory. `session-export-responsive` failed all seventeen viewport variants in CI while passing locally: the export entry button mounts only after workspace loading completes, and the `expect.poll` watching it carried the five-second expect default, which co-file contention at two pool workers on hosted runners reliably exhausts. `runtime-start-feedback` failed to read the start reply's body in any environment: CDP `getResponseBody` never exposes the error response once the renderer consumes it, so even reading inside the response event throws `No data found for resource with given identifier`.

## Decision

`session-export-responsive`'s readiness poll now carries an explicit thirty-second budget, matching the degradation margins sibling suites already declare. `admin-runtime-start-browser.mjs` proxies the start POST through `page.route`: `route.fetch()` performs the genuine round trip to the fixture server while the test captures status and JSON directly, then `route.fulfill({ response })` delivers the untouched reply to the page — the UI observes the real exchange and the test never depends on CDP body retention.

## Alternatives considered

- **Raising the expect timeout globally** — hides readiness regressions in every other suite and contradicts the per-wait budgets the resilient files already declare explicitly.
- **Reading the response body eagerly in the event listener** — attempted first; CDP still had no body for the error reply, proving retention rather than timing is the defect.
- **Asserting only the status code** — drops the `node-service/unavailable` payload contract that distinguishes the fixture's refusal shape from unrelated failures.

## Consequences

Both fixes are local-validated: `runtime-start-feedback` passes 5/5 and `session-export-responsive` passes 18/18. Suites that wait on workspace boot should declare explicit poll budgets rather than inheriting the expect default; suites capturing error-response payloads should route-proxy rather than read CDP bodies. Related: [the Admin matrix budget note](2026-11-25-admin-matrix-hosted-budget.md) covers the lane-level contention structure these waits now tolerate.
