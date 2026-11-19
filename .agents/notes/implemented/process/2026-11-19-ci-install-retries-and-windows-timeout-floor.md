# Agent Note: CI install retries and the Windows-native timeout floor

Status: implemented

English | [中文](2026-11-19-ci-install-retries-and-windows-timeout-floor.zh.md)

## Problem

Two hosted-runner failure classes repeatedly broke otherwise-green CI on 2026-11-18. First, single-shot download steps with `timeout-minutes: 5` — the four Playwright browser installs (benchmarks, web snapshots, Linux audit, browser cache), the CJK font install, and the Wine install — timed out roughly nine times in one day. Each step ran one command under one connection, so a stalled mirror or CDN edge always consumed the whole budget and failed the job, while a fresh connection almost always succeeds. Second, `DSH_COVERAGE_TEST_TIMEOUT_MS: '90000'` stopped holding in the windows-native lane: a degraded-runner draw in the hosted pool pushed a dozen `lsp-stdio` lifecycle cases past 90 s each in run 44376483787 (three attempts) and in master run 44371214606 at the same base, while the whole file takes ~6 s on a healthy runner.

## Decision

Each stall-prone install step now runs a bounded retry loop: `timeout -k 30 240` caps one attempt at four minutes with a kill grace, three attempts, fifteen seconds between attempts, and the step budget raised to `timeout-minutes: 20`. GNU `timeout` without `--foreground` signals the attempt's whole process group, so apt/dpkg children cannot survive into the next attempt; a kill that lands mid-unpack can still leave broken package state, so each retry first runs `dpkg --configure -a` and `apt-get install -f -y`. Retrying replaces the dead connection that consumed the budget rather than lengthening its stay.

The windows-native lane floor `DSH_COVERAGE_TEST_TIMEOUT_MS` moves from 90000 to 180000. The floor still suppresses the routine hosted-runner stalls the original 30 s → 90 s raise addressed, and now also covers the moderate-degradation draws that pushed lsp-stdio past the old value. A catastrophically wedged runner still fails — no finite floor rescues it — so the job-level rerun remains the escape valve for those draws.

## Alternatives considered

A third-party retry action was rejected: it adds a supply-chain dependency for what a short bash loop expresses directly. A longer single-attempt timeout was rejected because a stalled connection rarely recovers; a fresh attempt is strictly better per unit of budget. Per-test Vitest `--retry` was rejected because it also masks genuine product flakes; retries belong at the download/install boundary where the failure is the network, not the code under test. Waiting for the `20261103` runner image to leave the pool was rejected as the sole mitigation: the passing attempt of run 44376483787 drew the same image version as the three failing attempts, so the degradation tracks the individual VM, not the image rollout.

## Verification

All six rewritten `run` blocks parse under `bash -n`, and the workflow YAML loads and resolves all 25 jobs. The floor value flows through `coverageTestTimeoutOptions` into `testTimeout`, `hookTimeout`, and `expect.poll.timeout`, whose mapping `scripts/coverage-partitions.spec.ts` pins. CI on the introducing change exercises every retried step (they are unconditional) and the windows-native lane under the new floor.

## Consequences

A download step that stalls all three attempts now burns at most ~14 minutes before failing, versus failing at five minutes before; a stalled-then-recovered connection now passes. Windows-native worst-case lane time grows only for tests that actually stall, by up to the added 90 s each. Draws degraded beyond the new floor still fail, which is the intended signal rather than noise to suppress.
