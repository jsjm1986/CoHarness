# Agent Note: Gateway runtime credential lifetime

Status: implemented

English | [中文](2026-10-31-gateway-runtime-credential-lifetime.zh.md)

## Problem

A Gateway launch can supply its credential through a one-shot pipe. Replacing the transport provider rereads the exhausted descriptor and loses authentication. The application still owns its sessions and managed authorization requirements.

## Decision

One application root retains its validated launch credential and decoded verification key. The private, non-enumerable value uses a stable symbol so a replacement module reads the same authority. An effect on the root removes it at application disposal. A failed channel read or key decode publishes no retained value. Environment changes cannot rebind a running application's organization or Runtime generation; a new application reads its own credential.

## Alternatives considered

**Retain identity inside the provider module.** Module replacement discards that state while the application remains alive.

**Cache by descriptor or credential path.** Independent applications can reuse those names and must not inherit each other's authority.

**Reread on every mount.** A pipe cannot replay consumed bytes; rereading a replaced file could rebind an existing application.

## Consequences

Provider replacement preserves launch authority, not in-flight transport operations. A different launch identity requires a new application. No credential is serialized or exposed as a public service field. A real pipe replay replaces both the provider and its module, refuses an exhausted pipe in another application, keeps two application generations separate, and repairs initial JSON and key failures. Root disposal removes the retained value. Browser admission remains owned by the [transport authentication decision](../architecture/2026-10-01-browser-auth-web-transport.md).
