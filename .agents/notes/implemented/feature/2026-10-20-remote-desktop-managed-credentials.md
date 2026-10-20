# Agent Note: Remote-desktop endpoints terminate authentication host-side through stored credentials

Status: implemented

English | [中文](2026-10-20-remote-desktop-managed-credentials.zh.md)

## Problem

Every remote-desktop attachment required the operator to type the target machine's login into a browser form: the RFB handshake ran end to end on the client socket, so the desktop password passed through every browser that opened a stream. Apple Remote Desktop authentication (security type 30) offers no anonymous mode, so a frequently used machine — the deployment's own Mac mini endpoint — made the prompt the single dominant interaction cost, and any operator-facing credential storage would have handed the raw password to the web client.

## Decision

An endpoint may declare `username` and `passwordRef`; declaring `username` alone is a load-time and admin-time configuration error, because a login name with nothing to authenticate it is meaningless. `passwordRef` is a credential-store reference — the existing `ctx.credentials` seam — never a value, so the endpoint file and the admin API carry identifiers only.

When the reference is present, `serveStream` runs a managed handshake: the provider dials the endpoint, resolves the reference per stream through `ctx.credentials`, and completes upstream authentication host-side while the browser-facing socket negotiates only security type `None`. The client's noVNC session therefore sees an already-authenticated desktop and never renders a credential form; the password crosses no browser and no wire. Upstream negotiation supports `None` (1) and Apple Remote Desktop (30) — the provider performs the ARD Diffie–Hellman exchange itself, deriving the AES-128-ECB key as `MD5(sharedSecret)` and submitting the 128-byte credential block — while servers offering neither are refused with `REMOTE_DESKTOP_TRANSPORT`. A missing provider, an unresolved reference, or a rejected credential fails loud: the session detaches and audits rather than hanging on a prompt nobody can answer.

`pumpRfb` gained `clientPreamble`/`upstreamPreamble` options so the managed path can inject the browser-facing `None` preamble while splicing residual bytes read past each handshake boundary. `RfbClientFilter` operates in phases: a view attachment presented `None` starts in the framed-message phase — the client never sends a security selection the upstream already consumed — while the interactive path still parses the preamble before framing begins.

The admin surface carries the same contract: `endpoints.json` rows and the gateway admin service accept the two fields, reject `username` without `passwordRef` (`remote-desktop-username-without-passwordref`) and reject non-POSIX `passwordRef` values (`remote-desktop-passwordref-invalid`), and the endpoint editor labels the mode without ever requesting or displaying a password.

## Alternatives considered

**Browser-side credential persistence.** Rejected: it stores the machine password in web-client state and still sends it through every attaching browser — the opposite trust direction from keeping the secret inside the host's credential store.

**A dedicated remote-desktop secret store.** Rejected: `credentials-local` already owns `$DSH_HOME/.credentials.yaml` with POSIX-reference validation, layered resolution, and update notification; a second store would split rotation, backup, and permission policy per credential kind.

**Always-on host-side negotiation for unmanaged endpoints.** Rejected: without a stored reference there is nothing to authenticate with, and intercepting the handshake on interactive endpoints would break the browser's `credentialsrequired` flow. The managed mode engages exactly where a reference exists; every other endpoint keeps the end-to-end handshake it had.

## Consequences

Administrators set the login and reference once in the endpoint configuration (or Admin → Remote Desktop); operators attach without a prompt. The interactive path is untouched — endpoints without `passwordRef` behave exactly as before — and grant, consent, audit, view-only filtering, and recording semantics apply identically under both modes. The upstream-negotiation surface is deliberately narrow: `None` and ARD cover macOS Screen Sharing and the common Linux VNC servers; a server limited to password-only VNC authentication (type 2, DES) cannot be managed and must stay interactive until a DES path exists.

`tests/managed-handshake.spec.ts` drives the exchange against an in-memory ARD server that decrypts the real AES-ECB credential block and recovers the submitted login, and asserts the browser-facing preamble plus post-auth view filtering. `tests/service.spec.ts` covers a reference that resolves to nothing, a view-only managed attachment, and a `username`-without-`passwordRef` load error; the gateway service spec rejects the same invalid combinations at the admin boundary.

## Verification

`pnpm vitest run packages/remote-desktop/remote-desktop-vnc` covers the crypto exchange, residual-byte splicing, filtering, and failure modes; `pnpm vitest run gateway` covers the admin schema.
