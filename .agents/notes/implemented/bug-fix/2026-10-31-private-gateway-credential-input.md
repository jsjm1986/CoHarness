# Agent Note: Private Gateway credential input

Status: implemented

English | [中文](2026-10-31-private-gateway-credential-input.zh.md)

## Problem

JSON syntax diagnostics can include private credential bytes. Invalid URL errors can retain the supplied origin as an error property. The origin allowlist also compared an unbracketed IPv6 address with the URL parser's bracketed hostname, refusing the intended loopback address.

## Decision

Credential JSON parsing and origin parsing replace engine errors with static diagnostics, without retaining raw causes or input properties. Channel I/O failures keep their existing diagnostic context. Origin validation compares canonical URL hostnames against the exact loopback allowlist, including `[::1]`. User information, public or wildcard hosts, HTTPS, path prefixes, queries and fragments remain refused. Application identity retention stays owned by the [credential lifetime decision](2026-10-31-gateway-runtime-credential-lifetime.md).

## Alternatives considered

**Retain the engine error as a cause.** Startup reporting can traverse it and disclose the same input.

**Admit IPv6 through a broader host rule.** Canonical hostname comparison accepts the intended literal without admitting public or unspecified IPv6 addresses.

## Consequences

Malformed input remains a validation failure without exposing its JSON excerpt or origin text. Missing-file errors remain actionable. Source tests refuse synthetic input in inspected diagnostics and cover accepted loopback forms with invalid-origin controls. A keyless runtime replay verifies private diagnostic recovery and origin validation through compiled Node 22 and 24. No real credential is read by these fixtures; parser acceptance does not establish physical IPv6 Gateway deployment coverage.
