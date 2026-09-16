# Agent Note: DeepSeek image pricing uses the V41 token grid

Status: implemented

English | [中文](2026-09-13-deepseek-v41-image-token-calculator.zh.md)

## Problem

The provider catalog already exposed the V41 image model, but CoHarness still used the earlier V4 vision-token estimator for every retained image. That made heuristic context pressure and pre-request pricing materially low for current image requests.

## Decision

Adopt the provider's V41 grid calculation: scale images below a 544×544 pixel floor, project 14px patches with 3:1 downsampling, and solve the largest aspect-preserving grid under the 1,024-token per-image cap. Keep provider-reported usage as the billing and disclosure authority. The existing request-image byte, pixel, offload, Files API, and cancellation policies are unchanged.

The shared estimator remains the route-independent helper used by DeepSeek request pricing. Existing V4 model ids continue to use the same provider adapter and gain the current estimator; this affects only heuristic estimates because completed calls replace them with exact usage.

## Consequences

Context pressure, compaction decisions, and request-image pricing now reflect the current V41 image cost model. Image dimensions and deterministic request text remain unchanged. The calculator is bounded and converges through the same projection passes used by the prior implementation.

## Alternatives considered

**Keep the V4 calculator for every model.** The current catalog includes V41 and the old cap materially underprices its image requests.

**Use provider usage only.** Exact usage is authoritative after a call, but pre-request pressure and compaction decisions still need a bounded estimate.

## Verification

Provider reference cases, extreme aspect ratios, cap behavior, low-detail projections, request-image pricing, and existing DeepSeek adapter tests pass. Actual provider usage should still be checked in a deployment using real image requests, since the estimator is not a substitute for the response usage fields.
