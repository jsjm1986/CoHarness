# CoHarness

English | [中文](README.zh.md)

**CoHarness is a self-hosted, multi-user agent workspace built on DeepSeek Harness (DSH).**

CoHarness combines the Cordis plugin runtime from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) with a product layer for authenticated teams: personal and shared project workspaces, durable conversations, document workflows, model governance, usage accounting, and an administrator Gateway. The user-facing brand is CoHarness; runtime package names, plugin ids, file conventions, and compatibility-facing APIs intentionally retain the `dsh` vocabulary so upstream alignment remains practical.

CoHarness is an independent derivative project, not a rebranded upstream release. Upstream DSH remains the reference for the underlying plugin and agent-runtime contracts. CoHarness adds and maintains its own Gateway, collaboration, administration, document, deployment, and Android capabilities. Synchronization with upstream is selective and behavior-based; this repository does not promise byte-for-byte or commit-for-commit parity with every upstream release.

## Who it is for

- **Personal users** can run a local Web workspace, connect a model provider, choose a project directory, and let an agent inspect or change files with approval prompts and durable conversation history. A local setup does not require PostgreSQL or the Gateway.
- **Team members and project leads** can use authenticated personal spaces and shared projects, invite members with `ro` or `rw` access, collaborate in shared conversations, and keep project files and runtime state in the project scope.
- **Organization administrators** can operate the Gateway, manage users and projects, authorize model routes, review usage and audit records, configure quotas, and manage deployment and backup procedures.
- **Integrators and developers** can compose Cordis plugins, use the TypeScript or Python SDK, connect through JSON-RPC or ACP, and add model, tool, storage, or execution providers.

## Choose a setup

| Situation | Recommended setup | What it gives you |
| --- | --- | --- |
| Try the product on one computer | Local `dsh web` | A browser workspace using local files and local session storage; no Gateway or PostgreSQL required. |
| Run repeatable automation | Headless, JSON-RPC, ACP, or an SDK | Non-interactive sessions, streamed events, and integration with scripts or services. |
| Give a team authenticated access | Gateway plus Web runtimes | Users, personal spaces, shared projects, permissions, model governance, usage, and audit. |
| Enforce stronger Linux isolation | Gateway with systemd deployment | Per-runtime accounts, mount namespaces, directory grants, and kernel-level project confinement. |
| Access a hosted workspace on mobile | Web UI or the Android shell | Browser or Capacitor access to an already deployed Gateway; push notifications are optional. |

CoHarness is in pre-release development. Treat production deployment as an evaluated self-hosting responsibility: public APIs, configuration, database schemas, session formats, and deployment procedures may change. Linux systemd provides stronger process and directory confinement than macOS; the macOS launcher is intended for trusted-team development or deployments whose host permissions provide the required protection. See the [Gateway reference](gateway/README.md) and [deployment runbook](gateway/deploy/README.md) before exposing a service to users.

## Start as a personal user

The shortest local path is:

1. Start the [Web UI](#run-from-source) from the directory that contains the files the agent should use.
2. Open **Settings → Models** and configure a DeepSeek key or another supported provider.
3. Choose the workspace directory in the Web UI.
4. Ask the agent to inspect, explain, edit, or organize the workspace. File changes, commands, and other governed operations can require approval under the active permission policy.
5. Return to the same workspace later to resume durable sessions and review their conversation and tool history.

The [Web user guide](docs/user/guide/index.md) covers the first session, model configuration, workspaces, and follow-up tasks. Use the [CLI reference](apps/cli/reference/README.md) for headless jobs, profiles, and plugin-managed setups.

## Use it as a team

The Gateway is the multi-user control plane. Each account has a personal space, while a shared project uses one project-scoped runtime and persistence. Project members receive `ro` or `rw` access; conversations can be project-visible or creator-private, and project permissions are checked by the host rather than trusted to the browser. Administrators manage users, projects, invitations, model-route authorization, quotas, usage summaries, audit records, and runtime health.

Organization-managed model routes can be authorized per role, user, and project. Personal users may use their own BYOK routes; shared project runtimes remain catalog-controlled. Usage records attribute activity without storing API keys, prompts, or responses in the ledger. Linux deployments add systemd and mount-namespace confinement; macOS deployments do not provide that kernel boundary and should be treated accordingly.

Read the [Gateway reference](gateway/README.md) for the control-plane behavior and the [deployment runbook](gateway/deploy/README.md) for PostgreSQL, releases, isolation, TLS, backups, upgrades, and rollback.

## What it provides

| Area | Current capability |
| --- | --- |
| Agent runtime | Cordis profiles and bundles, event-sourced sessions, durable resume/fork, prompt and tool composition, model requests, approvals, questions, plans, goals, todos, jobs, workflows, compaction, telemetry, and session projections. |
| Tools and execution | Workspace filesystem tools, image reading, shell and persistent terminal sessions, LSP, web search/fetch providers, skills, structured attachments, user documents, and sandbox or directory policies. |
| Models | DeepSeek and pi-ai adapters, catalog and custom Providers, OpenAI-compatible and other supported protocols, per-user BYOK routes, organization-managed routes, model selection, reasoning controls, image admission/canonicalization, Files uploads with fallback, and credential references that keep secrets out of logs. |
| Web UI | Responsive browser application for sessions, live conversation history, model selection, command and `@` suggestions, image/document attachments, document management, workspace selection, permission controls, goals, subagents, jobs, settings, localization, themes, and feedback. |
| Projects | Personal and shared project scopes, one shared runtime per project, `ro`/`rw` membership, invitations, project or creator-private conversations, participant attribution, root-inherited visibility, directory grants, administrator authority, and project-level default authorization for organization models. |
| Documents | Named user documents, uploads and downloads, attach-to-conversation workflows, scope-aware browsing, cross-scope copies, snapshot lineage, operation history, collision-safe targets, and PostgreSQL metadata reconciliation while file bytes stay in runtime-owned directories. The default has no per-document size cap; transport, filesystem, and deployment storage limits still apply. |
| Gateway and Admin | PostgreSQL-backed authentication, users, projects, instances, collaboration, model Providers and catalog, quotas, usage, audit records, document catalog, HTTP/WebSocket proxying, runtime principals, health diagnostics, and a separate Admin SPA. |
| Security and deployment | Linux systemd mount namespaces, `dsh-directory-guard`, sandbox policies, Landlock/native launchers, macOS local/launchd operation, Nginx or tunnel frontends, owner-only credential files, immutable production releases, and SQLite-to-PostgreSQL import/rollback tooling. |
| Integrations | TypeScript SDK, Python SDK and bundled runtime, JSON-RPC, Agent Client Protocol (ACP), Codex and Claude Code hook bridges, optional Codex/Claude subagent providers, and a Capacitor Android shell with optional FCM/JPush/vendor notifications. |

## DSH relationship and naming

The repository keeps these upstream conventions deliberately:

- The npm scope remains `@deepseek-ai/dsh-*` for runtime package compatibility.
- Cordis plugin names, profile and bundle manifests, `cordis.patch.yml`, `DSH_HOME`, and DSH configuration vocabulary remain available to existing tooling.
- Upstream architecture, protocol, session-event, and plugin contracts remain the compatibility reference where CoHarness has not added a product-specific layer.
- CoHarness-owned features are documented as CoHarness behavior and may have different storage, authorization, UI, and deployment contracts from upstream DSH.

Use the [architecture guide](docs/architecture.md) for the plugin model and the [user guide](docs/user/guide/index.md) for the current Web workflow. The [Gateway reference](gateway/README.md) and [deployment runbook](gateway/deploy/README.md) own the hosted multi-user control plane.

<a id="run"></a>

## Run locally

### From source

<a id="run-from-source"></a>

Requirements: Node.js `^22.19.0` or `>=24.0.0`, Corepack, and a supported platform for the local runtime.

```sh
git clone https://github.com/jsjm1986/CoHarness.git
cd CoHarness
corepack enable
pnpm install
pnpm run build
pnpm dsh web --no-open
```

Open the URL printed by the command, normally `http://127.0.0.1:3080`. The invoking directory becomes the initial filesystem location. The Web UI starts without a selected workspace; choose a directory before starting a conversation.

Configure a model in **Settings → Models**. DeepSeek keys, catalog Providers, and custom Provider/model routes are supported. Personal users may add arbitrary Provider and model identities; the Gateway records non-secret registration activity for administrators but does not use that history as an approval list. See [model configuration](docs/user/guide/providers.md).

Run a one-shot task without the browser:

```sh
pnpm dsh --profile headless "Inspect this repository and summarize the main risks."
```

The headless profile writes a durable session and prints the final assistant response. Profiles and external plugin bundles are managed through the [`dsh` CLI reference](apps/cli/reference/README.md).

### Deploy the multi-user Gateway

The Gateway is the production path for authenticated users and shared projects. It uses PostgreSQL 17, a configured organization and compute node, a release-built Web/Admin bundle, and either Linux systemd or the macOS launchd/local launcher. It can sit behind Nginx or a tunnel such as Cloudflare Tunnel.

```sh
pnpm install --frozen-lockfile
pnpm run build:production
```

Follow [gateway/deploy/README.md](gateway/deploy/README.md) for database preparation, migrations, credential files, project roots, runtime confinement, cutover, backup, and rollback. Do not expose a Gateway or runtime port directly when deploying a public service.

## Repository map

| Path | Responsibility |
| --- | --- |
| [`apps/cli/`](apps/cli/README.md) | `dsh` launcher, profiles, Web/headless entry modes, and plugin management. |
| [`apps/web/`](apps/web) | Web application entry and production frontend build. |
| [`apps/android-shell/`](apps/android-shell/README.md) | Capacitor Android shell for a hosted CoHarness Web UI. |
| [`gateway/`](gateway/README.md) | Authenticated PostgreSQL control plane, Admin SPA, proxy, runtime lifecycle, governance, usage, audit, and deployment assets. |
| [`packages/`](packages/README.md) | Cordis capability packages and browser/host UI packages. |
| [`plugins/`](plugins) | Tree-external policy and security plugins, including model governance and directory enforcement. |
| [`python/`](python/README.md) | Python SDK and bundled runtime carriers. |
| [`native/`](native/README.md) | Native launchers, including Landlock-based process confinement. |
| [`docs/`](docs) | Architecture, user, developer, protocol, testing, and generated reference documentation. |
| [`examples/`](examples) | Runnable Cordis compositions and integration examples. |

## Development and verification

Read [AGENTS.md](AGENTS.md) and [docs/architecture.md](docs/architecture.md) before changing runtime packages. Common checks are:

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run doc-sync
```

Gateway-specific checks run from `gateway/`:

```sh
npm install
npm run typecheck
npm test
npm run test:postgres
```

PostgreSQL tests require a disposable `HGW_TEST_DATABASE_URL`; provider e2e tests require their documented credentials and self-skip only when the test policy permits it. Keyless snapshots, documentation gates, and built-artifact checks are part of the repository verification process. See [docs/testing.md](docs/testing.md) and [docs/development.md](docs/development.md).

## Status and compatibility

CoHarness is in pre-release development. Public APIs, configuration, database schemas, session formats, and deployment procedures may change without compatibility guarantees. PostgreSQL migrations are applied by the Gateway startup runner; SQLite is retained as a stopped-writes import and rollback source rather than the production control plane.

The project targets teams that want to run the complete workspace themselves. A deployment may use only the local DSH runtime, only the Gateway, or both. Features that depend on PostgreSQL, Linux systemd, Android vendor services, Codex, Claude Code, or external model Providers require those dependencies to be configured; they are not silently replaced by an unrelated fallback.

## Contributing and support

- Report CoHarness issues and product questions in [GitHub Issues](https://github.com/jsjm1986/CoHarness/issues).
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before preparing a change.
- Use the [developer documentation](docs/user/develop/basic/index.md) for plugins, tools, services, and LLM adapters.
- For upstream DSH contracts, ecosystem packages, and upstream discussions, consult [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## License and attribution

CoHarness is distributed under the [MIT License](LICENSE). The repository is an independent derivative of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), which is also distributed under the MIT License; the upstream copyright and license notice is retained in this repository. You may use, copy, modify, publish, distribute, sublicense, and sell the software under the MIT terms, subject to retaining the required notices.

Third-party dependencies, vendored sources, and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Do not treat the MIT license for this repository as permission to remove third-party notices or provider, platform, and service terms that apply outside the source tree.
