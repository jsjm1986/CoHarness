# Agent Note: Remote-desktop screen unwraps the bundled noVNC default across interop modes

Status: implemented

English | [中文](2026-10-20-remote-desktop-novnc-cjs-interop.zh.md)

## Problem

`new RFB(...)` threw `import_rfb.default is not a constructor` in the shipped client bundle, so the remote-desktop tab crashed its slot the moment an attachment was granted: the minted attach token was never consumed by any WebSocket and expired exactly one `attachTokenTtlMs` later — the same `attach`/`detach` sixty-second signature the runtime-pinning fix was meant to remove.

The cause sits one layer below the source. `@novnc/novnc@1.5` publishes only a Babel-transpiled CommonJS `lib/rfb.js` (`module.exports.default = RFB`). The client bundler wraps it in node-mode ESM interop (`__toESM(exports, 1)`), under which the import binding's `default` is the whole `exports` object — the class lives one level deeper at `default.default`. Source-level `import RFB from` reads the binding as if bundler-style `__esModule` interop applied, so the emitted property path missed the class entirely. Unit tests never saw this: `openScreen` is injected and mocked, and only the shipped artifact executes the real import.

## Decision

`src/client/rfb.ts` imports the module namespace once and unwraps `nested.default ?? rfbModule.default`, tolerating both interop faces — the class directly (bundler `__esModule` interop, as under vitest) or the exports object holding it (node-mode emit, as in the shipped combo). `index.ts` consumes the normalized binding; a client spec asserts the exported `RFB` is a constructor so the interop assumption is executable.

The 1.5 pin stands: 1.6+ moved to `core/` ES modules whose top-level await cannot bundle into the client runtime's rows.

## Alternatives considered

**Type the module as `export =` and consume `rfbModule.default` literally.** Rejected: `export =` matches the shipped artifact's node-mode emit, but under the test runner's `__esModule` interop the same expression resolves to `undefined` — the code would pass review and fail elsewhere. The runtime must tolerate both shapes; only the unwrap does.

**Upgrade noVNC to an ESM release.** Rejected: the version pin exists precisely because newer packages cannot bundle into the client module format; unpinning trades a localized unwrap for a bundling failure across the whole feature.

## Consequences

The tab's `openScreen` constructs the real class again, so consent → attach → WebSocket → RFB handshake runs end to end and the pending-token expiry signature disappears from the audit. Any future client import of a Babel-style `__esModule` CommonJS package needs the same unwrap or an explicit interop check — the shipped emit follows node-mode semantics, not bundler-style `__esModule` collapsing.

## Verification

`pnpm vitest run packages/client/ui-remote-desktop` covers the unwrap under the test interop; the shipped `lib/client.js` emit was inspected (`import_rfb.default.default`) and the real public site was driven end to end: consent → attach → `wss://…/stream?token=…&dshTarget=…` opened and `RFB 003.889` arrived at the browser.
