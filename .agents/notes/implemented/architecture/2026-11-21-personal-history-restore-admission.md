# Agent Note: Restore saved personal history on its owning Gateway

Status: implemented

English | [中文](2026-11-21-personal-history-restore-admission.zh.md)

## Problem

A page restoring a conversation can already identify its account, Runtime and Session. Waiting for the event stream and the complete Session and Workspace lists adds round trips before the reader can see recent messages. The owning Gateway also has to qualify the historical read against an organization database that can be several WAN round trips away.

## Decision

The browser uses the [prepared history API](../../../../packages/host/apiproxy/README.md) on the exact saved target. This request can only use a Runtime generation that is already ready. The Host may attest the active personal root Session for the tab to restore while the authoritative directory loads. A user navigation withdraws the pending selection. The authoritative directory controls visibility when it arrives. The editor holds new text in the tab while the account and Runtime are being verified, then saves it only for the same account, computer and Session. Sending requires Host target verification. The first page uses the [same bounded conversation window](2026-11-21-node-prepared-history-limit.md).

The [Gateway pilot](../../../../gateway/README.md#performance-and-runtime-admission) moves synchronous organization checks for eligible personal Runtime reads to the primary. Structured bootstrap and ordinary directory and history reads declare their expected account. The approval is bound to the browser login, method, path and exact target. The owner accepts it on a data socket attested by the Node Agent's live credential. The access listener must have applied the exact approved revision and the supervisor must retain the approved generation. The primary rechecks its current issuer key, governance authority and the generation before releasing the result. The Host continues to check Session ownership and visibility.

## Alternatives considered

**Restore from a browser copy of the history or a catalog row.** A cached row cannot establish current Session visibility after a revoke or archive, and browser persistence would put content on a second computer.

**Use the signed approval for writes.** Session creation, inbox acceptance and execution registration require their own durable authority at commit time.

## Consequences

A checked first page can render before the catalog and event stream. Approved startup and directory requests also avoid a remote governance query. The pilot keeps its ordinary SQL admission when the signature, socket, revision or ready generation cannot be established. Bootstrap keeps its forwarding audit and Runtime completion keeps its activity write. The bounded nonce ledger retains each live entry and refuses additional assertions when full.

The [assembled Web test](../../../../apps/web/tests/deferred-remote-entry.e2e.ts) holds Host and directory requests while the saved history appears. The [dual-Gateway fixture](../../../../gateway/tests/fixtures/versioned-node-service.mjs) checks the correlated primary and owner query counts. The [node service test](../../../../gateway/tests/node-service.spec.ts) withholds the response when the primary's second approval fails.
