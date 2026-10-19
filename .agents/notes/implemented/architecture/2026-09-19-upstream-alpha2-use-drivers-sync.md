# Agent Note: Driver and MCP integration with bounded cancellation

Status: implemented

English | [中文](2026-09-19-upstream-alpha2-use-drivers-sync.zh.md)

## Problem

Driver and MCP integrations combine upstream implementations with the fork's LLM lifecycle and package-resolution tests. A signal-blind adapter must not hold a cancelled review open, and synthetic resolution fixtures must not become installation dependencies merely to satisfy dependency analysis.

## Decision

Auto review uses the LLM service's bounded stream lifecycle. Cancellation outcomes and the reason for avoiding direct adapter iteration belong to the [Auto review decision](../feature/2026-08-28-auto-review.md). Upstream fixtures must exercise that production path; fixture signal handling does not establish a different cancellation policy.

Dependency analysis distinguishes runtime resolver manifests from test inputs. Bundle dependencies can supply packages named only by a Cordis composition. In contrast, the app-boot tests deliberately refer to missing or synthetic modules; their scoped exceptions in [`knip.json`](../../../../knip.json) do not create production dependencies or relax checks for other packages.

Experimental publication follows the [shared publication policy](../process/2026-09-12-experimental-publication-denylist.md). The [complete publication decision](../process/2026-09-12-publish-all-experimental-packages.md) owns the empty private denylist. The same policy applies to the driver and MCP packages.

## Alternatives considered

**Adopt an upstream assertion without its execution path.** A fixture that bypasses the LLM service cannot establish the result of a production review that uses it. Integration tests must preserve the actual cancellation owner.

**Declare synthetic profile-resolution fixture names as dependencies.** `metadata-lib`, `#missing`, `./relative.cjs`, and similar specifiers are deliberate test inputs. Installing them would alter what the tests exercise and misdescribe the runtime package requirements.

## Consequences

Upstream synchronization preserves runtime cancellation ownership and the distinction between installed packages and synthetic resolver inputs. Dependency exceptions remain scoped to their owning tests or resolver manifests. Benchmark availability and build verification follow the current repository configuration rather than a historical import inventory.

## Verification

The [Auto review tests](../../../../packages/experimental/auto-review/tests/auto-review.spec.ts) exercise late provider outcomes after caller cancellation. [Pre-push check selection](../../../skills/dsh-pre-push-checks/SKILL.md) selects dependency, build, and driver tests for the actual outgoing changes.
