---
kind: upgrade-guide
description: "Gateway launch credentials remain bound to their application across provider replacement."
---

# Upgrade Gateway credential lifetime

English | [中文](guide.zh.md)

## Change

Gateway runtime applications retain their first validated launch credential and decoded verification key across provider and module replacement. A one-shot descriptor is not read again on replacement. Another application cannot inherit that retained identity, and failed initial reads remain repairable. Application disposal releases the private retained value.

Malformed credential JSON and origin errors report input-free validation diagnostics. Canonical IPv6 loopback origins are accepted alongside the existing IPv4 and localhost forms; HTTP-only and exact-origin restrictions remain enforced.

## Action

Rebuild `@deepseek-ai/dsh-gateway-runtime` and deploy its compiled artifacts, then restart existing managed runtimes once. Changing organization, Runtime allocation or generation requires a new application; editing the credential file or environment does not rebind an existing application. No persisted data migration or model request is required.
