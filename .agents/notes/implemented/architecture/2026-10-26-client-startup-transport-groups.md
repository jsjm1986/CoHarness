# Agent Note: Explicit startup transport groups preserve shared application responses

Status: implemented

English | [中文](2026-10-26-client-startup-transport-groups.zh.md)

## Problem

A startup combo's URL and revision identify its entire ordered package set. Enabling two optional inspection packages changes the URL-length partition even when the shared application packages keep identical revisions and relative order. Profiles with different inspection settings then download the shared application code under different immutable response keys.

## Decision

[Client modules](../../../../packages/client/modules/README.md#use-this-package) owns optional application transport groups. The composing bundle selects its packages through validated configuration; the loader contains no feature-name policy. The Inspector bundle groups its two browser packages together, so its inclusion leaves the shared application sequence available under the same response keys.

The boot graph retains its original entry and dependency order. Grouping changes factory registration transport: the ungrouped application sequence is followed by configured groups, with each sequence preserving its graph order and the existing URL limit. [Lazy factory materialization](2026-07-23-client-plugin-loading-model.md) keeps module execution and CSS effects behind dependency arrival and Cordis import. Bootstrap packages retain their parser-preload sequence.

A group selects currently mounted packages rather than requesting installation or activation. An absent member contributes no resource. Repeated membership and bootstrap membership fail configuration validation because both would make transport assignment ambiguous or contradict parser ownership.

The [page-owned entry controller](2026-09-23-page-owned-client-entries.md) and [static-extension combo route](2026-10-20-combo-route-static-extension.md) retain their existing ownership and caching rules. Graph updates use the established single-resource arrival path; changing an optional group's code leaves unrelated startup responses reusable.

## Alternatives considered

**Remove inspection features.** That changes the available product capabilities instead of eliminating redundant transfers.

**Reorder the application graph.** Independent entries can still have observable activation order; cache grouping does not authorize changing it.

**Give every package a startup request.** This increases first-visit request overhead. A bundle-owned group isolates the measured membership change while retaining the shared response.

**Choose a universal hash-bucket count.** A useful default requires evidence across optional package sets, compressed sizes and cold networks. Explicit groups have a current composing consumer and avoid an unsupported global transport policy.

## Consequences

Transport groups can increase cold response count or change compression efficiency, so cache reuse is accepted together with complete-response byte counts and ordinary browser startup and switching observations. Request reuse alone does not establish faster full UI readiness. Dependency materialization, immediate entries, source maps, immutable revisions and HMR remain required behavior checks.

Grouping affects code delivery only. It introduces no Session data format, model input, task scheduling rule or process budget.
