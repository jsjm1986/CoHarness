# Agent Note: Gateway deployment environment stays outside runtime inheritance

Status: implemented

English | [中文](2026-10-25-gateway-runtime-environment.zh.md)

## Problem

The local launcher removes credential-like variable names but inherits `HGW_DATABASE_URL`, other Gateway settings and generic database URLs. A runtime tool or plugin can read those inherited values even though its Gateway credential grants only one runtime generation. The independent supervisor also receives the Gateway launch environment.

## Decision

Local Runtime, supervisor and managed tunnel child environments exclude `HGW_*` deployment configuration, `DSH_*` state and names containing `KEY`, `PASSWORD`, `SECRET`, `TOKEN`, `CREDENTIAL` or `DATABASE_URL`, plus `PGPASSFILE`. Prefix and credential-name matching is case insensitive. The launcher explicitly supplies runtime HOME, private DSH paths and its credential descriptor after filtering; the recovery capability travels through private IPC rather than environment variables.

Ordinary host tooling settings, including PATH and proxy configuration, remain inherited. An operator-selected `HGW_DEFAULT_ENV_FILE` and runtime-owned configuration files remain explicit inputs. This changes Gateway-managed launch inheritance; the standalone credential provider's [ambient-source decision](../architecture/2026-07-30-credential-boundaries-and-atomic-registration.md) remains applicable to standalone compositions.

Tunnel PATH lookup, selected-binary version probes and archive extraction use the same environment filter. Discovery executes code with access to its environment even when no connector is running.

## Alternatives considered

**Remove only `HGW_DATABASE_URL`.** Other deployment variables and credential aliases still reach the runtime. The deployment prefix is reserved for the Gateway.

**Allowlist every host environment variable.** That requires maintaining unrelated locale, certificate, proxy and toolchain settings. Filtering the owned prefix and known credential names addresses the observed inheritance failure without replacing host-tool configuration.

**Hide environment-reading tools.** Plugins and subprocesses can read their own environment directly; a tool presentation rule cannot remove inherited authority.

## Consequences

Gateway deployment settings cannot supply runtime configuration through ambient inheritance. Workloads that intentionally need database or cloud settings use their own explicit configuration. The name filter does not recognize secrets hidden under arbitrary aliases and does not create OS isolation between processes sharing the local host account.

## Verification

An actual Node runtime records only variable presence while the parent supplies synthetic values. The regression exposes all five reserved/database/credential variables before the fix and none after it, while PATH remains available. The compiled launcher acceptance checks the same exclusion through an independently supervised process. Real tunnel processes check the shared filter through authenticated administrator actions. Real Web-profile assembly covers authenticated Gateway access, resource registration and recovery of personal and shared-project runtimes.

Executable PATH and version fixtures record only synthetic credential presence. The version regression exposes deployment variables before repair and excludes them after repair.
