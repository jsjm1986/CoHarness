# Agent Note：Windows lane 的测试断言平台事实，而非 POSIX 拼写

Status: implemented

[English](2026-09-02-windows-test-portability.md) | 中文

## 问题

[可移植 runner 默认值](../process/2026-09-02-portable-ci-runner-defaults.zh.md)用 GitHub 托管的 `windows-2025` 取代了从未配置过的企业 runner 池之后，`windows node 24 / native complete` lane 第一次真正执行。它的 `test:coverage` 门禁报告了七个在 Linux 与 macOS 上通过、在 Windows 上失败的测试文件。没有一个失败暴露出产品缺陷：每一处都是写进测试本身的 POSIX 假设，外加一个维护脚本调用了 Windows 拒绝的操作。

- `userdoc-local/tests/name.spec.ts` 用 `join(sep, 'home', 'alice', 'uploads')` 构造文档根目录。在 Windows 上这是一个带根却没有盘符的 `\home\alice\uploads`；被测代码会把它解析成 `D:\home\alice\uploads`，于是所有针对字面根目录的相等断言都失败，而以无盘符拼写为键的"已占用名字"集合也永远匹配不上解析器产出的路径。
- `userdoc-local/tests/store.spec.ts` 断言保存文件的模式位为 `0o600`。Windows 没有 POSIX 权限位，统一报告 `0o666`。
- `directory-picker-browse/tests/service.spec.ts` 授予 `/` 并列出 `/etc`。Windows 的根目录带盘符，`/etc` 在那里不是完全限定路径。
- `apiproxy/tests/api-proxy-collaboration.spec.ts` 把项目根配置为 `/tmp`、项目目录配置为 `/tmp/project`。Host 会通过 `realpath` 规范化配置的根目录；runner 上不存在 `D:\tmp`，所以每个项目范围内的调用都以 `gateway-unavailable` 失败，根本没有触及包含规则。
- `tool-pwsh-persistent/tests/loader-composition.spec.ts` 用 `realpathSync(root)` 与 PowerShell 报告的 `cwd` 比较。runner 的临时目录以 8.3 短名（`RUNNER~1`）发放，只有 `realpathSync.native` 才能把它展开成 PowerShell 打印的长拼写。
- `apps/cli/tests/shipped-preset-root.spec.ts` 在一个由启动器用平台分隔符拼出的路径里断言正斜杠子串 `config/agent-presets`。
- `scripts/session-sqlite-migration.ts` 以只读方式打开完成的输出文件，并对它和父目录都执行 `fsync`。Windows 的 `FlushFileBuffers` 需要可写句柄，并以 `EPERM` 拒绝目录句柄。

## 决策

每个测试现在都用被测代码所使用的同一套路径原语，断言它原本就想断言的平台无关事实：

- 文档根目录改为 `resolve(sep, 'home', 'alice', 'uploads')`，在所有平台上都完全限定；包含测试里的逃逸路径也以同样方式解析。
- owner-only 模式位断言与文件系统根授权测试用 `it.skipIf(process.platform === 'win32')` 声明，并附注释点明它们依赖的 POSIX 事实。该行为在存在它的平台上仍被覆盖。
- 协作 spec 从 `os.tmpdir()` 派生 `PROJECT_ROOT`，再用 `join(PROJECT_ROOT, 'project')` 派生 `PROJECT_DIR`，使配置的根目录在每个 runner 上都存在，测试真正演练的是包含规则。
- pwsh loader 测试期望 `realpathSync.native(root)`，它既能解析 macOS 的 `/var` → `/private/var` 别名，也能展开 Windows 短名。
- shipped-preset 测试期望 `join('config', 'agent-presets')`。
- 迁移脚本的 `finalizeOutput` 以 `r+` 打开输出文件，并在 `win32` 上跳过父目录 `fsync`——那里的目录项无需它即可持久化。POSIX 行为保持不变。

## 考虑过的替代方案

**把这七个文件从 Windows lane 排除。** 不采用，因为七个里有六个测试的是真实的跨平台行为——文档命名、项目包含、PowerShell cwd 持久化、预设根目录——而 Windows 是所有这些行为的受支持宿主。只有两条字面意义上就是 POSIX 事实的断言被跳过，且按断言而非按文件跳过。

**在被测代码里归一化路径以迎合测试。** 不采用，因为代码本来就是正确的：它用 `node:path` 解析路径，而测试拿来比较的拼写是 `node:path` 在 Windows 上永远不会产出的。

**保留目录 `fsync` 并吞掉 `EPERM`。** 不采用，因为对持久化原语裸 `catch` 会在该调用有意义的平台上掩盖真实故障。平台分支如实陈述了实际约束。

## 后果

Windows lane 剩下的 `test:coverage` 失败是另行跟踪的、各平台共享的逐文件覆盖率债务；不再有 Windows 特有的测试失败。协作 spec 的项目根现在依赖 `os.tmpdir()` 存在且可规范化，这是每个受支持 runner 都保证的。两条仅限 POSIX 的断言被显式标记；若 owner-only 或根授权契约将来获得 Windows 语义，需要补上对应的 Windows 断言。
