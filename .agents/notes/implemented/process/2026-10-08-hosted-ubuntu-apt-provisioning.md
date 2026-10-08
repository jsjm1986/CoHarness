# Agent Note: Bounded authenticated APT provisioning on hosted Ubuntu runners

Status: implemented

English | [中文](2026-10-08-hosted-ubuntu-apt-provisioning.zh.md)

## Problem

Hosted Ubuntu jobs ran `apt-get` unbounded: GitHub's `azure.archive.ubuntu.com` mirror can stall without response, retry loops multiplied the stall, and product-proof step budgets absorbed network time. Bubblewrap was fetched through a full dpkg transaction whose post-install work the sandbox rung did not need.

## Decision

[scripts/prepare-ci-apt.mjs](../../../../scripts/prepare-ci-apt.mjs) replaces the hosted image's Azure archive mirror with the canonical `https://archive.ubuntu.com` source, upgrades plain-HTTP archive, security, and ports URIs (amd64 and arm64) to HTTPS, preserves every unrelated source byte-for-byte including `Signed-By` lines, suites, and components, and writes a `98-dsh-ci-network` conf with exact bounded settings (20s HTTP(S) timeouts, `Retries 0`, `APT::Update::Error-Mode any`, 30s dpkg lock). It is idempotent — a repeat run reports no writes — and propagates source IO failures unmodified; APT owns source syntax validation. [.github/actions/prepare-ci-apt](../../../../.github/actions/prepare-ci-apt) exposes it only to `github-hosted` Linux runners and requires root, keeping persistent VMs and local machines untouched.

Every material consumer wires preparation immediately before its APT transaction under the consumer's own condition: the four Playwright `--with-deps` installs and `Install Wine` in ci.yml, the master Wine cache-miss download (a credential-free `actions/checkout` precedes the local action and the download, since composite actions require a checked-out tree), the Linux musl installs in both landlock workflows, and the sandbox Landlock leg. Each provisioning step carries `timeout-minutes: 5`; the sandbox bwrap leg instead runs [scripts/prepare-ci-bubblewrap.sh](../../../../scripts/prepare-ci-bubblewrap.sh) — the SHA-256-pinned .deb payload plus bounded curl flags — under `timeout-minutes: 3`, keeping product proof time separate from network time.

## Alternatives considered

- **Retry loops around apt-get.** Retries multiply a stalled mirror's cost rather than remove the cause; the canonical archive plus a zero-retry bounded policy removes both the slow path and the retry machinery.
- **Leave the image mirror as-is.** The Azure mirror is the degradation source itself; rewriting it to the canonical archive is the fix, not an optimization.
- **Install bubblewrap via apt like the other tools.** The rung needs only a SHA-256-pinned .deb payload plus an AppArmor knob; the payload fetch is auditable and bounded, and keeps the existing functional probes.

## Testing

[scripts/prepare-ci-apt.spec.ts](../../../../scripts/prepare-ci-apt.spec.ts) exercises the writer against private filesystem fixtures (mirror list, legacy `.list`, Deb822 `.sources`, signing preservation, unrelated sources, idempotence, IO propagation, exact network policy). [scripts/prepare-ci-apt-workflow.spec.ts](../../../../scripts/prepare-ci-apt-workflow.spec.ts) enumerates every APT/Playwright consumer in the five owning workflows and asserts preparation order, matching conditions, budgets, VM exclusion, and the pinned payload. Hosted Ubuntu runs provide the network proof these fixture tests cannot.

## Consequences

Canonical sources plus explicit step deadlines make provisioning failures bounded and attributable: network time is capped at five minutes per transaction (three for the pinned bwrap fetch), signing posture is unchanged, and unrelated image sources survive untouched. The persistent failover VM keeps owning its image-level Playwright packages. [Dual Wine and native Windows pull-request CI](2026-08-08-native-windows-pull-request-ci.md) keeps its lane topology; [portable CI runner defaults](2026-09-02-portable-ci-runner-defaults.md) keeps its runner-selection rationale.
