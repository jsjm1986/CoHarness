# CoHarness

English | [中文](README.zh.md)

**CoHarness is a multi-user agent harness built for teams.**

CoHarness is independently maintained and based on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) under the MIT License. It keeps the Cordis-powered, plugin-based runtime and adds shared project workspaces, authenticated collaboration, administrative controls, and a deployable Web UI.

## Highlights

- **Team workspaces:** share project conversations while preserving participant identity and project or private visibility.
- **Access control:** manage administrator and user roles, read-only or read-write project membership, and directory grants.
- **Central governance:** operate user and project runtimes through one Gateway with managed model access and usage visibility.
- **Plugin architecture:** compose tools, providers, policies, interfaces, and agent behavior as Cordis plugins.
- **Self-hosting:** run the Web UI locally or deploy the Gateway behind infrastructure you control.

## Status

CoHarness is under active pre-release development. Configuration, APIs, and persisted formats may change without compatibility guarantees.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

```sh
git clone https://github.com/jsjm1986/CoHarness.git
cd CoHarness
corepack enable
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Read the [architecture documentation](docs/architecture.md) before changing runtime packages. Contributor setup and repository commands are documented in the [development guide](docs/development.md), and agent contributors must follow [AGENTS.md](AGENTS.md).

## Upstream and License

CoHarness is an independent derivative of DeepSeek Harness, originally developed by DeepSeek AI. Original copyright and license notices are retained.

The project is distributed under the [MIT License](LICENSE). Third-party dependencies and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
