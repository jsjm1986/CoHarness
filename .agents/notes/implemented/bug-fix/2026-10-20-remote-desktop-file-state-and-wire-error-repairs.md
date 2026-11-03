# Agent Note: Remote-desktop file state reloads transactionally and capability failures keep their wire codes

Status: implemented

English | [中文](2026-10-20-remote-desktop-file-state-and-wire-error-repairs.zh.md)

## Problem

The file-backed state paths had four independent integrity defects. `syncEndpoints` recorded the endpoint file's mtime before parsing it and cleared the live map before validating rows, so one malformed external write permanently emptied the endpoint table while consuming the revision — every later call saw the same mtime and returned the empty map silently. `VncGrantStore` repeated the pattern: `refresh` committed `seenMtimeMs` before `reload` succeeded, `reload` cleared the map before parsing all lines, and `persist` pre-marked its own write's mtime as seen, which hid an external rewrite landing in the same tick. The endpoint key was assembled by string concatenation in two places, so `('ab','c')` and `('a','bc')` shared one key — consent or endpoint resolution could cross between distinct desktops. Four controller methods (`listGrants`, `grant`, `setLevel`, `revoke`) returned provider rejections untranslated, so a `RemoteDesktopError` reached the client without the `details.code` the tab body branches on. And `VncAuditLog.open` parsed the tail with a bare `JSON.parse`, so a crash-truncated last line failed the whole capability at load.

## Decision

Both reload paths commit transactionally: the file is read and fully parsed into a temporary map before any in-memory state changes, the prior map is replaced only on success, and the file revision is consumed only after the parse commits — a malformed write fails loudly on every call until a valid file lands, and the last good rows stay in effect for reads that complete first. `parseEndpointsFile` validates JSON syntax, the `endpoints` array, and each row's `nodeId`/`desktop`/`host`/`port` shape before deduping, failing with `REMOTE_DESKTOP_TRANSPORT` that names the file. `endpointKey` is the single key constructor and serializes `[nodeId, desktop]` as JSON, so no pair of distinct targets collides; `persist` leaves the observed revision unconsumed. Revisions include device, inode, byte count and nanosecond modification/change timestamps, so an atomic replacement that preserves mtime still invalidates the cache. `listGrants(attachable)` additionally requires a configured endpoint for the target — the guide never lists a grant `attach` would reject at dial. All eight controller Remote methods route capability rejections through `translate`, so `RemoteDesktopError.code` reaches the client as `remote-desktop/failure` details. `VncAuditLog.open` drops an unreadable tail row with one `logger.warn` instead of failing; the audit contract keeps readable rows.

Gateway and provider grant mutations share the local `grants.jsonl` writer lock. Each mutation reads the complete current rows, applies its change and atomically publishes before updating its cache. Independent runtime inserts and level changes preserve committed revocations and other principals' rows. Gateway endpoint replacement shares that lock with grant creation, keeping target validation and publication serialized. Only `ENOENT` permits Gateway initialization or empty grants; other read failures return503 and preserve existing bytes. Replacement files use private permission bits and exclusive temporary acquisition. This lock does not coordinate different hosts or PID namespaces sharing a filesystem.

## Alternatives considered

**Treat a missing or corrupt endpoints file as empty.** Rejected: a corrupt deployment file is a misconfiguration the administrator must see, and silently serving an empty table converts a write error into denied attaches with no diagnostic.

**Hash file content on every refresh.** Device/inode and nanosecond metadata identify replacements without rereading unchanged files. Every grant mutation independently rereads the committed file under its writer lock; a cached revision never authorizes overwriting another writer. Writers sharing a path must use the same local lock and publish by atomic replacement.

**Map capability codes to per-method wire codes.** Rejected: `remote-desktop/failure` carrying the capability code in `details.code` is the contract the client already branches on; the fix restores that contract rather than widening the wire vocabulary.

## Consequences

A bad `endpoints.json` or `grants.jsonl` write degrades to loud, retried `REMOTE_DESKTOP_TRANSPORT` failures instead of silent state loss; both stores recover on the next good write without a restart. `attachable` listings now describe targets that are actually attachable. Clients receive stable `details.code` values for every management-method rejection. A crash mid-audit-append no longer blocks provider startup. The REAL-composition spec boots the provider through Loader/Include from a test-only `cordis.yml` — covering composition, external file convergence, and the filtered real-socket stream — while `controller.spec.ts`, `audit.spec.ts`, and the `grants.spec.ts`/`service.spec.ts` additions pin each repaired behavior.
