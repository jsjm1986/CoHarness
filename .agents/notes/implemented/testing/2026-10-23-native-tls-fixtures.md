# Agent Note: Native cryptography for disposable TLS fixtures

Status: implemented

English | [中文](2026-10-23-native-tls-fixtures.zh.md)

## Problem

TLS integration tests need a certificate that clients verify, including localhost and both loopback IP families. Committing a private key makes disposable test material indistinguishable from leaked credentials. The fixture dependency also needs a maintained cryptography stack without retaining the test-only node-forge dependency. The asynchronous generator API and certificate-validity options must remain consistent across its consumers.

## Decision

The [WebServer TLS fixture](../../../../packages/host/webserver/tests/tls-fixture.ts) uses `selfsigned` 5.5 with native WebCrypto and `@peculiar/x509`. Its pending generation is shared within one process; every materialization awaits it, and a failed generation permits a subsequent attempt. The existing asynchronous fixture API continues serving the WebServer and built Web-profile tests.

The certificate uses RSA-2048 and SHA-256, explicit start and end dates thirty days apart, and the existing server-auth extensions for `localhost`, `127.0.0.1` and `::1`. The helper writes material only into caller-owned temporary directories and keeps the private key owner-readable. Real TLS tests require the generated trust anchor; clients without that trust anchor reject the server.

## Alternatives considered

**Retain the synchronous generator.** The 4.x dependency keeps node-forge in the test graph. Version 5.5 supports the required extensions through an asynchronous API, so its callers await generation rather than preserving that dependency.

**Commit a static certificate and key.** Every checkout would retain private-key material, while the certificate would eventually expire. Disposable generation keeps the trust anchor local to each test process.

## Consequences

The test dependency graph resolves one `@peculiar/asn1-schema` version without an override. Its actual extension construction and a verified HTTPS handshake are tested; package-version deduplication alone does not prove certificates work. The integration case checks all three names and the thirty-day validity interval. Production certificate provisioning and listener policy remain unchanged.
