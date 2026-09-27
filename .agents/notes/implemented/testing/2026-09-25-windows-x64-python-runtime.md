# Agent Note: Python runtime publishes a native Windows x64 wheel

Status: implemented

English | [中文](2026-09-25-windows-x64-python-runtime.zh.md)

## Problem

The Python runtime distribution was POSIX-only in practice: the platform manifest already carried a wired `win-x64` row and the executable builder already modeled a `win` platform, but no workflow built the target, the ripgrep sidecar lookup searched `runtime.exe-rg` instead of `runtime-rg.exe`, the minimal composition mounted only the bash dialect, and the packaged-runtime smoke hard-coded bash commands and `/tmp`. Windows x64 users therefore had no installable wheel and no merge-blocking signal protecting the packaged Windows path.

## Decision

`win-x64` is a first-class runtime target publishing `deepseek-harness-sdk-runtime-win-x64.exe` under the `py3-none-win_amd64` tag, with a `deepseek-harness-sdk-runtime-win-x64-rg.exe` sidecar. [resolveRgPath](../../../../packages/fs/tool-fs-search/src/search-core.ts) derives the sidecar name from `process.execPath`'s parsed stem on Windows and keeps the `<execPath>-rg` convention elsewhere; upstream's Electron `.asar.unpacked` branch is not carried because no Electron host exists here — it returns with a desktop host.

The [minimal composition](../../../../examples/jsonrpc-agent/minimal.cordis.yml) selects its persistent-shell dialect through `disabled: !!js` conditionals on the platform: `dsh-tool-pwsh-persistent` over a `pwsh`-dialect `dsh-terminal-bash` backend on Windows, `dsh-tool-bash-persistent` elsewhere. The packaged-runtime smoke selects `pwsh` or `bash` tool names, PowerShell or bash command bodies, and `tempfile.gettempdir()` or `/tmp` expectations from `sys.platform`. The minimal model-visible snapshot gains a `minimal/win-x64/` variant because the advertised tool name, description, and command-parameter text differ by dialect; the advanced snapshot stays single because its tool surface is platform-independent.

Required pull-request CI builds `node24-linux-x64` and `node24-win-x64` on their native runners through the shared builder, which runs Windows steps under native `pwsh`. [Release validation](../../../../.github/workflows/python-release.yml) retains all five targets and checks the `win_amd64` wheel's exact filename.

## Alternatives considered

**Exercise the packaged runtime through Wine.** Rejected because the supported product surface is native Windows execution — ConPTY terminals, ACL sandboxing, and `pwsh` resolution — and Wine already owns the separate Windows build/site check rather than the published wheel.

**Keep bash on Windows through WSL or Git-Bash.** Rejected because `pwsh` is the harness's Windows shell dialect and the minimal composition must not mount a POSIX-only interface where the persistent `pwsh` tool already exists.

**One shared minimal snapshot.** Rejected because the model-visible tool name and its description differ between dialects; masking them would remove the surface the snapshot exists to pin.

## Consequences

Windows x64 users install the same production carrier contract as POSIX users. The packaged Windows path — executable, `-rg.exe` sidecar, `pwsh` composition, wheel tag, and installed-wheel smoke — is merge-blocking on every pull request, while macOS and Linux ARM64 packaging regressions still belong to release validation.

## Verification

`verify-runtime-closure` reports 4 agent presets and 151 workspace packages in a closed graph; `scripts/ci-workflow.spec.ts` pins the PR and release target lists (18 tests); `tool-fs-search` passes 153 tests including the sidecar-resolution cases that pin the POSIX and Windows naming plus the no-sidecar fallback; a macOS arm64 build plus `scripts/smoke-python-runtime.py --scenario all` passes every keyless scenario and re-records the POSIX snapshots. Native Windows execution is CI-owned; the committed `minimal/win-x64` expected output is what the Windows leg compares against.
