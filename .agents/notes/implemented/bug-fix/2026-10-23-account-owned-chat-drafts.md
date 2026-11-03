# Agent Note: Account-owned chat drafts

Status: implemented

English | [中文](2026-10-23-account-owned-chat-drafts.zh.md)

## Problem

A runtime-qualified Session id distinguishes shared projects but does not identify the browser's current account. Persisting an unsent draft by that id alone lets another member who opens the same shared Session on the same browser restore private text. The [auxiliary sidebar decision](../architecture/2026-09-23-account-scoped-auxiliary-sidebar.md) establishes the corresponding ownership rule for tab metadata.

## Decision

Gateway chat persistence uses the verified account, runtime, and original Session id. Reading or writing requires current catalog ownership. An unverified account has no storage key; it cannot adopt a legacy record or publish a pending draft when verification arrives. An explicit independent Host preserves its local storage keys.

The browser document identity fence owns the confirmed account until explicit account, credential or Runtime identity invalidation. Renewing an expiring event stream withdraws current permission eligibility while retaining that document ownership. A temporary absence of Host metadata cannot cancel pending Session navigation or rehydrate an empty draft over current input; private keys still require the visible Session and its exact Runtime. Compositions without that document owner withdraw identity on context invalidation.

The conversation plugin owns persistence subscriptions and store generations. Replacement and plugin disposal stop old writes. Session deletion can resolve an erasure key after catalog withdrawal, but only under the current verified principal; erasure does not authorize a read. Identity changes before notification cannot redirect an old instance's write or deletion into another account's record.

Each tab synchronously mirrors its owned record into session storage and restores that copy before the shared local-storage copy. A new tab seeds its own copy from the durable record. Recovery eligibility requires current ownership and an exact saved snapshot; a shared durable record alone cannot prove which tab's draft a reload will restore. Images, document references, unmirrored input, pending initialization and active submission retain the source tab; space navigation offers the prepared destination in a new tab instead of disposing that input.

Legacy Gateway records carry no record of the writer's account and remain unimported. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/account-owned-chat-drafts/guide.md) describes preserving an owner's unsent text.

The sidebar keeps authorized blank Sessions discoverable while this document holds their composer input. It observes the existing `composer` reference counts, including attachments and pending submission, without acquiring Session scopes, opening Runtime connections or inspecting draft text. Directory withdrawal and plugin disposal remove the corresponding subscriptions. Grouped and flat lists retain the same computer and Workspace ownership; empty parked blanks remain hidden.

## Alternatives considered

**Reuse runtime-qualified Session keys.** Members deliberately share those identities, so they cannot isolate unsent input.

**Import legacy records into the next authenticated account.** The record does not establish which account wrote it. Automatic import can reproduce the disclosure.

**Require visible catalog membership for deletion.** Session removal can withdraw the catalog row before the store cleanup runs, leaving private records behind.

## Consequences

An omitted persistence policy creates an in-memory chat store. Only the plugin's verified owner policy enables browser storage. Gateway users preserve their own legacy drafts before upgrading; independent Hosts retain local rehydration. Browser storage corruption or denial leaves the composer usable in memory.

## Verification

The assembled Web profile reopens one shared Session as two accounts in the same browser and records each account's independent draft across four visits. Store and SlotRegistry regressions cover identity withdrawal, delayed notifications, replacement, disposal, and Session deletion. The storage owner and chat persistence modules receive per-file 100% coverage rather than the broad GUI composition exemption.

The unified-space browser scenario gives two tabs of the same Session different drafts, reloads and switches one tab, protects an image draft, and completes a real replay-backed AgentLoop turn after navigating away from its source.
