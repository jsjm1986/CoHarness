# Engineering records

English | [中文](README.zh.md)

This directory contains engineering review and verification records that apply across packages or deployments. It is separate from product documentation and from the per-release upstream records in [`upgrades/`](../upgrades/README.md).

| Record | Scope |
| --- | --- |
| [`BENCHMARK.md`](BENCHMARK.md) | Performance baselines and repeatable measurement guidance. |
| [`CODE-QUALITY-REVIEW-2026-09-08.md`](CODE-QUALITY-REVIEW-2026-09-08.md) | Repository-wide quality review findings and follow-up evidence. |
| [`PLUGIN_SECURITY_PLAN.md`](PLUGIN_SECURITY_PLAN.md) | Plugin security review and implementation planning. |

Add a new record here when its subject spans multiple packages or deployment targets. Package-specific contracts belong with the package README, incidents belong in [`docs/postmortem/`](../docs/postmortem/README.md), and an upstream release decision belongs in [`upgrades/`](../upgrades/README.md).
