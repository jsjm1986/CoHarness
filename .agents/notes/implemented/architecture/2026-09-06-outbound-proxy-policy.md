# Agent Note: Process-wide outbound proxy policy

Status: implemented

English | [中文](2026-09-06-outbound-proxy-policy.zh.md)

## Problem

Node's `fetch` does not consume the proxy environment automatically, while some SDKs construct their own transports. A configured `HTTP_PROXY` or `HTTPS_PROXY` could therefore be ignored by model, web, MCP, or sandbox requests, and a second matcher at one call site could disagree with the process policy.

## Decision

`@deepseek-ai/dsh-http-proxy` resolves one policy from the immutable launch environment snapshot and installs it before the first profile plugin mounts. Plain `fetch` uses the installed undici dispatcher. SDKs that own a proxy option receive the result of `proxyRouteFor`; spawned children receive `proxyEnvironmentForChild`, and test/replay processes can use `clearedProxyEnv`.

Lowercase environment names take precedence on POSIX, uppercase is the fallback, and `ALL_PROXY` supplies both schemes. Loopback is always bypassed. Unsupported schemes and malformed values are diagnosed and left direct for that scheme. The launcher disposes the policy after the profile fiber so nested invocations restore the previous dispatcher and environment.

Telemetry and model-authored worker processes remain direct by design. The former uses a Node HTTP transport that does not reach the global dispatcher; the latter must not receive a credential-bearing proxy URL.

## Alternatives considered

**Set `NODE_USE_ENV_PROXY` only.** Rejected because it does not cover the launcher's `.env` layer, older supported Node versions, or SDKs with their own transport.

**Thread a proxy argument through every request.** Rejected because it duplicates policy resolution and would leave future call sites unprotected. One process-wide dispatcher plus explicit escape hatches keeps the decision centralized.

**Route telemetry and model-authored workers too.** Rejected because telemetry's transport does not share the dispatcher and worker code must not receive a credential-bearing proxy value.

## Consequences

New ordinary `fetch` call sites inherit the policy without imports. Custom transports must explicitly consume `proxyRouteFor`, and each external SDK path needs an egress test proving whether it is proxied. Direct proxy installation remains process-scoped rather than a Cordis plugin capability.

## Verification

The package policy, installation, matcher-parity, CLI profile, package dependency, typecheck, and release verification suites pass on the sync branch.
