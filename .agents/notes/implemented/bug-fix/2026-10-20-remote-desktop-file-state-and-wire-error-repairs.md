# Agent Note: Remote-desktop file state reloads transactionally and capability failures keep their wire codes

Status: implemented

English | [中文](2026-10-20-remote-desktop-file-state-and-wire-error-repairs.zh.md)

## Problem

The file-backed state paths had four independent integrity defects. `syncEndpoints` recorded the endpoint file's mtime before parsing it and cleared the live map before validating rows, so one malformed external write permanently emptied the endpoint table while consuming the revision — every later call saw the same mtime and returned the empty map silently. `VncGrantStore` repeated the pattern: `refresh` committed `seenMtimeMs` before `reload` succeeded, `reload` cleared the map before parsing all lines, and `persist` pre-marked its own write's mtime as seen, which hid an external rewrite landing in the same tick. The endpoint key was assembled by string concatenation in two places, so `('ab','c')` and `('a','bc')` shared one key — consent or endpoint resolution could cross between distinct desktops. Four controller methods (`listGrants`, `grant`, `setLevel`, `revoke`) returned provider rejections untranslated, so a `RemoteDesktopError` reached the client without the `details.code` the tab body branches on. And `VncAuditLog.open` parsed the tail with a bare `JSON.parse`, so a crash-truncated last line failed the whole capability at load.

## Decision

Both reload paths now commit transactionally: the file is read and fully parsed into a temporary map before any in-memory state changes, the prior map is replaced only on success, and the mtime is consumed only after the parse commits — a malformed write fails loudly on every call until a valid file lands, and the last good rows stay in effect for reads that complete first. `parseEndpointsFile` validates JSON syntax, the `endpoints` array, and each row's `nodeId`/`desktop`/`host`/`port` shape before deduping, failing with `REMOTE_DESKTOP_TRANSPORT` that names the file. `endpointKey` is the single key constructor and serializes `[nodeId, desktop]` as JSON, so no pair of distinct targets collides; `persist` no longer pre-marks its own mtime, so an external rewrite is always re-read. `listGrants(attachable)` additionally requires a configured endpoint for the target — the guide never lists a grant `attach` would reject at dial. All eight controller Remote methods route capability rejections through `translate`, so `RemoteDesktopError.code` reaches the client as `remote-desktop/failure` details. `VncAuditLog.open` drops an unreadable tail row with one `logger.warn` instead of failing; the audit contract keeps readable rows.

## Alternatives considered

**Treat a missing or corrupt endpoints file as empty.** Rejected: a corrupt deployment file is a misconfiguration the administrator must see, and silently serving an empty table converts a write error into denied attaches with no diagnostic.

**Hash file content instead of trusting mtime.** Rejected as disproportionate: mtime granularity is the only residual race, it cannot hide a change made after the observed stat, and content hashing buys little for kilobyte-scale files read per call.

**Map capability codes to per-method wire codes.** Rejected: `remote-desktop/failure` carrying the capability code in `details.code` is the contract the client already branches on; the fix restores that contract rather than widening the wire vocabulary.

## Consequences

A bad `endpoints.json` or `grants.jsonl` write degrades to loud, retried `REMOTE_DESKTOP_TRANSPORT` failures instead of silent state loss; both stores recover on the next good write without a restart. `attachable` listings now describe targets that are actually attachable. Clients receive stable `details.code` values for every management-method rejection. A crash mid-audit-append no longer blocks provider startup. The REAL-composition spec boots the provider through Loader/Include from a test-only `cordis.yml` — covering composition, external file convergence, and the filtered real-socket stream — while `controller.spec.ts`, `audit.spec.ts`, and the `grants.spec.ts`/`service.spec.ts` additions pin each repaired behavior.
