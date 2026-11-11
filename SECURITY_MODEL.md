# Security model

Repository: `jsjm1986/CoHarness` (DeepSeek Harness, `@deepseek-ai/dsh`). The repo has no `SECURITY_MODEL.md`. `SAFETY.md` is a pre-release disclaimer: sandboxing, approvals, Gateway authentication, project ACLs and credential isolation reduce risk but are not guaranteed isolation. The infrastructure description below comes from the in-repo deployment code (`gateway/deploy/`); no separate infrastructure repository was used.

## User-provided facts (from the setup questions)
- Deployment: a **multi-user Gateway exposed to the internet** (e.g. `harness.maycran.com`), behind TLS / Nginx or a Cloudflare Tunnel.
- Attackers: **all of them matter**: unauthenticated internet users, signed-in users going after other users' projects, sessions or admin, prompt injection through model output, web pages or files, malicious plugins, MCP servers, skills or hooks, and a compromised node agent or remote computer.
- Assets: **all are equally critical**: provider API keys and credentials, host and user files, session transcripts, the admin control plane.
- Out of scope / accepted risk: **nothing**. The whole repository is in scope, including `packages/experimental`, the Android shell, macOS and Windows paths.
- Finding tags: `Component` only.

Because the user ruled nothing out, reranking keeps the scanner's severity for almost every finding.

## System overview and trust boundaries
1. **Internet → Gateway**: browsers and the Android shell reach the Gateway over TLS. The Gateway binds `127.0.0.1` (`gateway/src/index.ts`: main port `HGW_PORT` 8899 plus an intake port), and a reverse proxy or Cloudflare Tunnel publishes it.
2. **Gateway → per-user/per-project dsh runtimes**: the Gateway authenticates users (PostgreSQL sessions, argon2, `gateway/src/auth.ts`), applies user/project/directory grants (`apply-grants.ts`) and reverse-proxies HTTP and WebSocket traffic to loopback runtimes, rewriting Host and Origin. Runtimes run as systemd user units under per-user Unix accounts (`gateway/deploy/*.service`, `provision-user.sh`). Shared projects run as `harness-project`.
3. **Gateway ↔ node agents / other computers**: node enrollment, node channel and forwarded principal assertions (Ed25519-signed), and node content and peer backup (`gateway/src/node-*.ts`, `gateway/docs/node-agent`).
4. **Runtime → model and tools**: model output is untrusted. It drives shell, subprocess, fs, web fetch/search, MCP, hooks, skills, workflow and PTC tools, confined by the sandbox (`read-only` / `workspace-write` / `danger-full-access`) and the directory guard.
5. **Runtime → external services**: LLM providers, web destinations (public-destination validation in `web_fetch`), webhooks (GitHub), push providers (JPush/FCM), Cloudflare API.
6. **Plugins**: Cordis in-process plugins. Admin-approved plugins run with host privileges; `engineering/PLUGIN_SECURITY_PLAN.md` describes the planned trust tiers and admission flow.

## Components
| Component | Code |
|---|---|
| Gateway | `gateway/src/` (auth, sessions, grants, reverse proxy, `/admin/api`, `/account/api`, collaboration, documents, archives, model budget, tunnel), `gateway/admin-ui/` |
| Node agent | `gateway/src/node-*.ts`, `forwarded-principal.ts`, `execution-identity.ts`, `gateway/docs/node-agent`, `gateway/docs/peer-backup` |
| Web client | `apps/web/`, `packages/client/`, `apps/android-shell/` |
| Remote API | `packages/api/`, `packages/sdk/`, `packages/acp/`, `packages/typert/`, `packages/host/` (connection/webserver) |
| Agent runtime & tools | `packages/core/`, `shell/`, `subprocess/`, `terminal/`, `fs/`, `web/`, `mcp/`, `hooks/`, `skill/`, `workflow/`, `ptc-runtime/`, `subagent/`, `webhook/`, `attachment/`, `session/`, other `packages/*`, `apps/cli/`, `packages/experimental/`, `python/`, `native/` |
| Sandbox & directory guard | `packages/sandbox/`, `plugins/dsh-directory-guard/`, `packages/interaction/` (approvals, permission presets) |
| Credentials & model governance | `packages/credentials/`, `packages/settings/`, `plugins/dsh-model-governance/`, `plugins/dsh-steward-tools/`, Gateway credential key files (`HGW_*_KEY_FILE`) |
| Deployment & build | `gateway/deploy/` (systemd units, Postgres compose, backup/restore, Windows/macOS agents), `scripts/`, `.github/workflows/`, `vendor/` |

## Entry points and who can reach them
- Gateway login, account, admin, runtime proxy and intake endpoints: anyone on the internet (pre-auth), signed-in users (post-auth), administrators.
- WebSocket and Typert RPC (`/api`) to runtimes: signed-in users, through the Gateway proxy.
- Webhook receivers: external providers with signing secrets.
- Node channel and enrollment: enrolled node agents.
- Tool inputs: model output, fetched web content, repository files, MCP server responses, hook output.
- Plugin, skill and profile loading: plugin authors and admins.

## Assets (all equally critical, per user)
- Provider API keys (company `company.env`, org/project keys encrypted with AES-GCM, personal `.credentials.yaml`), webhook, tunnel and push secrets, principal keys.
- Host and user files; command execution on Gateway and node hosts.
- Session transcripts and logs, conversation archives, documents.
- Admin control plane: users, grants, org settings, model governance, the bootstrap admin password.

## Existing controls (from the code)
Argon2 password hashing and hashed session tokens; idle and absolute session deadlines; administrator re-check on admin requests; per-user Unix accounts and systemd confinement; the directory guard `tools/pre-execute` gate and `workspace-files/authorize`; sandbox modes with fail-closed errors; `web_fetch` public-destination validation; Ed25519-signed forwarded principals; mode-0600 key files; RemoteSessionPolicy ACLs on session-scoped RPCs.

## Open questions
- Is any Gateway or runtime port reachable directly, without the reverse proxy?
- Are third-party (non-admin-approved) plugins allowed in production yet, or only the planned tiers?
