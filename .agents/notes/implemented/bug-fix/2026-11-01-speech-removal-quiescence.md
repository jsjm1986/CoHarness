# Agent Note: Speech withdrawal retains completion ownership

Status: implemented

English | [中文](2026-11-01-speech-removal-quiescence.zh.md)

## Problem

Removing a speech provider from the routing map did not end its accepted recognition work. A concurrent disposer or registry shutdown could see no registration and return before that work settled. A failed subscription disposer could also skip cancellation and joining.

## Decision

Each registration retains one removal promise before cleanup begins. The registry tracks those promises separately from routable providers. Withdrawal removes routing immediately, cancels accepted recordings and joins their settlement even when subscription cleanup throws. Repeated disposers await the same outcome. Registry shutdown waits every active or detached removal before reporting cleanup failures.

## Alternatives considered

**Retain the provider in the routing map until work settles.** That permits new recognition during withdrawal.

**Treat an absent routing entry as completed cleanup.** Routing availability does not establish whether previously accepted work has ended.

## Consequences

Disposal completion establishes quiescence for the registration. Lookup refusal remains immediate, replacements keep independent registrations and provider-owned preparation keeps its own lifetime. Service methods, stored settings and Session formats are unchanged.

## Verification

Controlled external work covers overlapping disposers, registry shutdown and a subscription-cleanup exception. The actual SDK application compares routing withdrawal with completion before and after releasing that work. Source and built original packages expose premature completion.
