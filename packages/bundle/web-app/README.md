---
description: "The dsh browser-surface bundle: the web patch layer over dsh-base plus the runtime glue plugin (frontend dist serving, bash runtime variables, URL line)"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-web-app`

English | [中文](README.zh.md)

The dsh browser-surface bundle. [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-base`](../base/README.md): it sets the coding persona, inserts the Web host rows (webserver, API gateway, workspace, projection cache, storage) and the browser plugin roster, the live client-plugin graph transport ([`dsh-client-hmr`](../../client/hmr/README.md), with artifact polling enabled only by `DSH_CLIENT_HMR=1` beside a rebuild watcher), and mounts this package's `web-runtime` glue plugin (config `{openBrowser, printUrl, surfaceContext, publicUrl}`). That plugin resolves the built frontend dist through `@deepseek-ai/dsh-web-frontend`'s exports, owns the advertised application URL, warns when a non-loopback bind serves plain HTTP, mounts the [`frontend-static`](../../host/frontend-static/README.md) fallback owner, and registers the bash-visible `DSH_WEB_URL` runtime variable when `surfaceContext` is true. After its Loader tree settles, it prints the `dsh web:` URL line when `printUrl` is true and opens the canonical application URL — the configured `publicUrl`, or the listener's bind-address URL — in the default browser when `openBrowser` is true and the inherited `SSH_CONNECTION` and `SSH_TTY` are blank or absent. An SSH launch keeps the URL line but suppresses browser handoff because the SSH client or editor owns the local forwarded address — a `--public-url` still changes the printed root, and the remote host's own browser cannot reach your screen. Immediately before a handoff, the runtime prints `dsh web: opening the default browser; pass --no-open to disable`. A short-lived Node helper runs the maintained platform opener with the canonical scrubbed child environment. On Windows it stays alive until the short-lived PowerShell launcher exits, because `open` reports spawn before that launcher has handed the URL to the shell; elsewhere the helper stops after the opener accepts spawn. A helper failure writes a diagnostic with its reason and the manual URL to stderr without stopping the server, and no path waits for the browser to exit. This bundle also owns the app command line: the ordinary `web-startup` provider ([`src/startup.ts`](src/startup.ts)) injects `ctx.cmdlineArgs` ([`dsh-cmdline`](../../boot/cmdline/README.md)), parses `--host`, `--port`, `--public-url`, repeatable `--trusted-host`, `--no-open`, and the app's `--help`, then provides `webStartup`; browser opening defaults on for local launches, and `--no-open` turns it off for this invocation. It rejects a wildcard `--host` — including the IPv4-mapped forms Linux reads as IPv4 any — before publishing that service, because binding every interface would expose remote code execution to the network; bind one concrete IPv4 or IPv6 address of a local interface instead. Flag-configured rows inject the service and read it directly from lazy config, so nothing binds a port before argument resolution and `dsh --profile web --help` starts no server. [`dsh-headless`](../headless/README.md) is a sibling surface over the same base and does not mount this bundle.

## Summary

Run `dsh --profile web` to open a browser GUI with chat, model and settings management, and session history. It uses the same model access, tools, and safety defaults as other dsh surfaces. Startup prints an authenticated URL and normally opens the default browser; SSH sessions and `--no-open` require manual opening. Change the port, allow extra authorities, bind one concrete local IP, and serve HTTPS from a certificate you supply; wildcard addresses are rejected. Remote access uses an advertised HTTP(S) URL behind a prefix-stripping proxy, listener TLS, or plain HTTP on a non-loopback bind. Use `dsh-headless` for one-shot command-line tasks.

## Table of Contents

- [Listening, trust, and public deployments](#public-deployments)
- [Model retry defaults](#model-retry-defaults)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="public-deployments"></a>
## Listening, trust, and public deployments

By default the GUI listens on loopback and accepts connections from this machine only. Only `--host` changes the listener: it accepts one concrete local IPv4 or IPv6 address, never a wildcard. A non-loopback listener without TLS serves plain HTTP and warns at startup, even when an HTTPS `--public-url` fronts it. The Host/Origin fence accepts the bind IP itself; other non-loopback authorities require `--trusted-host`, so a remote browser reaches the GUI behind a prefix-stripping proxy or through a port-forwarding client that presents a trusted hostname. The launch-token exchange and signed session cookie authenticate every API method and WebSocket stream.

Pass `--tls-cert` and `--tls-key` together to serve HTTPS from the listener instead of plain HTTP. Each names a file resolved against the process working directory: the certificate file holds the full chain and the key file an unencrypted PEM private key. The flags are one setting — supplying only one is a usage error, and supplying neither keeps the plain-HTTP default. Startup fails when a file is missing, unreadable, empty, or not a valid certificate-and-key pair; it never falls back to HTTP. Nothing re-reads the material while the listener runs, so serving a different certificate needs a listener reload or a process restart. DSH issues, renews, and watches nothing: there is no ACME client, no self-signed fallback, and no redirect listener. The browser applies its own trust store and host-name matching, so a certificate the browser does not trust, or one whose subject alternative names miss the authority you open, fails before the page loads. The default port stays 3080, and `--tls-cert`/`--tls-key` do not follow `--public-url`: the listener's certificate covers the authority browsers dial. TLS changes nothing about authority: Connection still authenticates every request and still checks Host/Origin, and the session cookie it mints is `Secure` whenever the receiving listener serves HTTPS.

A container can bind its Pod address and advertise the ingress that fronts it:

```sh
dsh --profile web --no-open --host "$(hostname -i | awk '{print $1}')" --public-url https://app.example/ --trusted-host app.example
```

`hostname -i` may list several addresses; `--host` takes one, so the command selects the first. A zone ID such as `fe80::1%eth0` cannot appear in a URL, so the advertised root drops a redundant loopback zone while a non-loopback zone requires an explicit `--public-url`. Without `--public-url`, mapped IPv6 loopback binds such as `::ffff:127.0.0.1` advertise their IPv4 form, `127.0.0.1`, so the browser recognizes a local, trustworthy origin; a dotted-quad IPv6 tail names the address's own low 32 bits, exactly as `listen` reads it, so `::0.0.0.1` is IPv6 loopback and advertises `[::1]`, while `::127.0.0.1` is a non-loopback address, not IPv4 loopback.

`--public-url` advertises the HTTP(S) root browsers use — the printed and opened startup URL, `DSH_WEB_URL`, and the Web GUI URL in the agent's runtime context. Advertisement grants no trust: the browser-visible authority must also be named with `--trusted-host`. The flag configures no listener, routing, or cookie scope, because the proxy owns the external leg: [Publish the Web UI behind a reverse proxy](../../../docs/user/guide/public-deployments.md) lists what such a deployment must provide. The `publicUrl` config field publishes the same advertisement.

Neither the advertised URL nor the browser-trust fence protects the port itself, so restrict the port to the trusted proxy or network. The printed URL contains a process credential; share it only with intended users, and `printUrl: false` suppresses the line with or without `--public-url`.

<a id="model-retry-defaults"></a>
## Model retry defaults

Web uses the shared bounded normal default of five eligible retries after the initial request. The `deepseek-official` route and settings-added pi-ai routes use that default when they omit `retryPolicy`; explicit provider policies still win. Web adds no retry-specific composition override, so the same omission behavior applies to non-Web profiles.

<a id="model-experience"></a>
## Model Experience

### Web runtime variable

#### What the model sees

When `surfaceContext` is true, `DSH_WEB_URL` appears in the managed bash environment with its description, resolved per invocation as the advertised application URL defined under Listening, trust, and public deployments above. When it is false, the variable is not registered. The GUI orientation, the implementation checkout, and the current GUI URL come from the [`dsh-harness-dev-context`](../../context/harness-dev-context/README.md) row this bundle mounts.

#### Token effect

Two managed-environment variable lines; constant per process.

#### KV Cache effect

None; the plugin contributes no system-prompt text.

## Known Limitations and Deferred Work

- **The frontend dist must be built** — `require.resolve` of the dist fails loud at activation with a build hint; there is no source-serving fallback.
- **TLS is opt-in and unmanaged** — the listener serves HTTPS only when `--tls-cert` and `--tls-key` name a full chain and its unencrypted key; DSH never obtains, renews, or watches certificates, and a changed file needs a listener reload or a process restart. The browser must trust that certificate, its names must cover the authority you open, and the certificate is independent of `--public-url`.
- **Without TLS the external leg is plain HTTP** — protect it with a TLS-terminating proxy, and do not send the launch URL over a network you do not trust.
- **Only handoff startup is observable** — observation ends when the platform opener accepts spawn, except that Windows waits for its short-lived PowerShell launcher to exit; a later browser exit is not reported, and the printed URL remains the manual fallback.
- **SSH forwarding owns the browser URL** — without an advertised root the printed URL names the remote host's bind-address endpoint (loopback for a loopback bind); automatic handoff is suppressed, and the SSH client or editor must expose and open its local forwarded address.
- **Binding all network interfaces is not supported** — a wildcard `--host`, including the IPv4-mapped forms Linux reads as IPv4 any, is rejected at startup for safety; bind one concrete IPv4 or IPv6 address of a local interface instead.
- **Browser command overrides are launch-only** — a discovered `.env` may not set `BROWSER`; only an inherited value may reach an opener path that honors the variable, so a checkout cannot choose an executable for automatic handoff.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
