# Agent Note: Compose the managed desktop driver from node configuration

Status: implemented

English | [中文](2026-09-25-managed-desktop-launch-composition.zh.md)

## Problem

A Gateway-launched runtime loads only the plugins its composed patch names. Administrator qualification and the managed desktop policy existed, but no launched runtime ever registered a desktop driver, so the managed desktop path could not execute a real call.

## Decision

The Gateway owns driver admission into launched runtimes through node configuration. `HGW_DESKTOP_ID` declares the node's interactive desktop identifier. When set, the launch composition materializes the provisioned Cua Driver MCP package into the runtime profile, appends `dsh-computer-use` and the driver to the managed patch, and writes `gateway-execution`'s `config.desktop`, which publishes the managed policy for that identifier. When unset, runtimes mount no driver, no policy is published, and the driver package is never read.

The driver package materializes through the same atomic staging mechanism as the model-governance and directory-guard packages: `HGW_DESKTOP_DRIVER_PACKAGE` names an absolute package directory whose `package.json`, `lib/`, and `cordis.patch.yml` are copied, never symlinked to a source checkout. Release deployments pin the default under `HGW_RELEASE_ROOT`; a missing or incomplete package fails the runtime mount loudly. `HGW_DESKTOP_DRIVER_COMMAND` and `HGW_DESKTOP_DRIVER_ARGS` replace the provider's `cua-driver` executable lookup and `mcp` argument vector with a literal command and JSON argument list, never a shell string.

`dsh-computer-use` resolves through the installation module fallback because `gateway-execution` declares it as a peer; only the driver package needs materialization. Exactly one driver row is emitted, preserving the service's single-provider invariant. `HGW_DESKTOP_ID` accepts one to 256 characters, mirroring the runtime `desktop` schema bound.

## Alternatives considered

- **Static rows in the governance patch gated by `!!js`:** the experimental driver package is not part of the shipped plugin set, so a gated row would name an unresolvable package; seat identity is also node configuration, not patch content.
- **An `OPTIONAL_BUNDLES` user-switchable slot:** optional bundles are CLI layers a user selects for a personal profile; managed desktop is administrator-controlled deployment behavior and must not depend on a per-user choice.
- **Unconditional mount:** nodes without a desktop would still launch a driver and publish a policy for a resource that does not exist.
- **Browser-use in the managed path:** deferred; it has no managed authorization seam, so mounting it would run without the policy.

## Related decisions

The [managed desktop execution note](2026-09-23-managed-desktop-execution.md) owns the policy, qualification, confirmation, and lease semantics this composition activates. The [provider registration note](2026-09-12-computer-use-provider-registration.md) owns the single-slot registration contract the emitted rows satisfy.

## Consequences

Launch composition depends on a provisioned driver package; a missing package fails every launch until the deployment corrects it. Upgrading the driver means replacing the provisioned directory. Every personal and project runtime on a desktop-enabled node carries the driver, and runtime-side policy still gates each call on current qualification and live-root confirmation. Tests cover the disabled default, enablement rows, command and argument overrides, release-root pinning, the materialized payload, and missing-package failure.
