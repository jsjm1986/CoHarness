# CoHarness

English | [中文](README.zh.md)

**CoHarness is a fully pluginized harness for teams to build, validate, and strengthen their own patterns for people-and-agent work.**

CoHarness combines the Cordis plugin runtime from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) with a product layer for authenticated teams. It does not prescribe one fixed kind of agent or one fixed collaboration workflow. A team can assemble the models, tools, roles, context, permissions, delegation paths, and workflows that fit its work, then capture practices proven in real projects as plugins, skills, profiles, bundles, or workflows. The user-facing brand is CoHarness; runtime package names, plugin ids, file conventions, and compatibility-facing APIs intentionally retain the `dsh` vocabulary so upstream alignment remains practical.

CoHarness is an independent derivative project, not a rebranded upstream release. Upstream DSH remains the reference for the underlying plugin and agent-runtime contracts. CoHarness adds and maintains its own Gateway, collaboration, administration, document, deployment, and Android capabilities. Synchronization with upstream is selective and behavior-based; this repository does not promise byte-for-byte or commit-for-commit parity with every upstream release.

## Collaboration philosophy

CoHarness treats collaboration as something a team builds, not a feature a team merely consumes. The team decides how agents should participate in its work, then assembles and refines that approach through plugins, profiles, bundles, skills, and workflows. The project is where those choices meet real work: it provides a shared environment and durable history in which people and agents can test a way of working, learn from it, and carry it forward.

The unit of collaboration is shared work, not a shared chat link. A project can hold one continuing agent environment, participant contributions, delegation relationships, pending decisions, and recoverable progress. People contribute direction, context, judgment, and authorization; agents investigate, execute, explain, and report. Sharing context does not grant unlimited access: membership, conversation visibility, and read/write authority continue to define each participant's role.

A primary agent can delegate part of the work to a specialist agent with a clear relationship, scope, and responsibility. A child agent may be a one-time specialist or a continuing collaborator that accepts later messages, resumes after interruption, and reports selected results back to its parent. Child work does not silently inherit every capability or permission, and its internal transcript does not flood the parent context. The team can therefore shape not only what agents can do, but also how responsibility and information move between them.

Human decisions are part of the work rather than a final review step. An approval authorizes a controlled action, while a question supplies the business judgment or missing context needed to continue. In a shared project, one valid participant claims a pending decision and the result becomes part of the common history, so concurrent responses do not produce competing outcomes.

Practices that work can be reused and strengthened. A successful delegation pattern, review step, context source, or tool policy can become part of the team's next plugin, skill, profile, bundle, or workflow. Contributions, delegation, pending decisions, progress, and outcomes remain available after a browser closes or an individual agent stops. CoHarness is built around these principles:

- Shared work, not shared chat, is the unit of collaboration.
- Identity and contribution belong in the work context, not only in the interface.
- Delegation follows explicit relationships and limits rather than copying every permission.
- Information moves to the people and agents who need it, instead of spreading without purpose.
- Human judgment is a first-class part of progressing work.
- Every task should be possible to continue, hand over, recover, and review.

## Who it is for

- **Personal users** can use the same durable work model on one machine without a Gateway or PostgreSQL.
- **Team members and project leads** can contribute to shared project work, take over an ongoing task, review agent activity, and respond to decisions within their authority.
- **Organization administrators** can establish the project, membership, model, usage, audit, and runtime rules that make collaboration accountable.
- **Integrators and developers** can extend the same collaboration model through plugins, SDKs, JSON-RPC, ACP, and new agent providers.

## Choose a setup

| Situation | Recommended setup | What it gives you |
| --- | --- | --- |
| Try the product on one computer | Local `dsh web` | A browser workspace using local files and local session storage; no Gateway or PostgreSQL required. |
| Run repeatable automation | Headless, JSON-RPC, ACP, or an SDK | Non-interactive sessions, streamed events, and integration with scripts or services. |
| Give a team authenticated access | Gateway plus Web runtimes | Users, personal spaces, shared projects, permissions, model governance, usage, and audit. |
| Enforce stronger Linux isolation | Gateway with systemd deployment | Per-runtime accounts, mount namespaces, directory grants, and kernel-level project confinement. |
| Access a hosted workspace on mobile | Web UI or the Android shell | Browser or Capacitor access to an already deployed Gateway; push notifications are optional. |

CoHarness is in pre-release development. Treat production deployment as an evaluated self-hosting responsibility: public APIs, configuration, database schemas, session formats, and deployment procedures may change. Linux systemd provides stronger process and directory confinement than macOS; the macOS launcher is intended for trusted-team development or deployments whose host permissions provide the required protection. Read the [safety notice](SAFETY.md) ([中文](SAFETY.zh.md)), [Gateway reference](gateway/README.md), and [deployment runbook](gateway/deploy/README.md) before exposing a service to users.

## Start as a personal user

The shortest local path is:

1. Start the [Web UI](#run-from-source) from the directory that contains the files the agent should use.
2. Open **Settings → Models** and configure a DeepSeek key or another supported provider.
3. Choose the workspace directory in the Web UI.
4. Ask the agent to inspect, explain, edit, or organize the workspace. File changes, commands, and other governed operations can require approval under the active permission policy.
5. Return to the same workspace later to resume durable sessions and review their conversation and tool history.

The [Web user guide](docs/user/guide/index.md) covers the first session, model configuration, workspaces, and follow-up tasks. Use the [CLI reference](apps/cli/reference/README.md) for headless jobs, profiles, and plugin-managed setups.

## Use it as a team

The Gateway turns the collaboration model into an authenticated project boundary. Each account has a personal space, while a shared project uses one project-scoped runtime and persistence; members do not receive disconnected copies of the same conversation. Project members receive `ro` or `rw` access, and a root conversation can be project-visible or creator-private with visibility inherited by its descendants. Permissions are enforced by the host and Gateway, not trusted to the browser.

A team can let one person start an investigation, another add context, a specialist agent inspect code or tests, and an authorized participant decide whether a waiting action may proceed. The shared history records those contributions and decisions, while selected child-agent reports keep the main task useful without importing every internal detail. A member can return to the project later and continue work from the same durable state.

Administrators manage users, projects, invitations, model-route authorization, quotas, usage summaries, audit records, and runtime health. Organization-managed model routes can be authorized per role, user, and project. Personal users may use their own BYOK routes; shared project runtimes remain catalog-controlled. Usage records attribute activity without storing API keys, prompts, or responses in the ledger. Linux deployments add systemd and mount-namespace confinement; macOS deployments do not provide that kernel boundary and should be treated accordingly.

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
