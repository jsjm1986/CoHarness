# Agent Note: Python 单可执行文件冒烟 fixture 与 fork 的 runtime-context 文本重新对齐

Status: implemented

[English](2026-11-16-python-single-exe-runtime-context-fixtures.md) | 中文

## 问题

Python 发布形态矩阵将打包可执行文件的输出与 fixture 比对，而这些 fixture 是在代码树短暂携带上游引语 `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.` 期间重录的。已吸收的 agent-loop 改动保留了 fork 自己的引语（`The following information describes your current session:`），所以发出的文本是正确的产品行为，fixture 才是陈旧的。fork 还会发出上游录制中缺少的 `subagent:identity`、`tool:subagent_fork:depth` 和 `subagent:delegation` 小节，因此每个过时 fixture 都需要同时修正引语句与小节清单，而非单行替换。

`scripts/smoke-python-runtime.py` 中的 `RUNTIME_CONTEXT_PREFIX` 驱动归一化逻辑，将平台相关的 runtime-context 块从模型可见比对中剔除。它只写了上游引语，因此以 fork 引语开头的块会逃过剥离，在发出它的平台上导致同样的比对失败。

## 决定

- `scripts/smoke-python-runtime.py`：`RUNTIME_CONTEXT_PREFIX` → `RUNTIME_CONTEXT_PREFIXES = ("Current runtime context", "The following information describes your current session")`；两处剥离点改用 `str.startswith(tuple)`。
- `scripts/snapshots/python-sdk-single-exe/` 下 15 个 fixture 文件（`advanced`、`advanced-ptc`、`restart`、`scheduler-recovery`、`authoring`）：替换引语句；root 会话复合文本补上 root `subagent:identity` 尾段与小节；委托复合文本补上 agent-id 身份句与 `tool:subagent_fork:depth` 小节，保留 `tool:subagent:depth`/`subagent:delegation`，并使用场景的 `{{agent-1}}`/`{{agent-2}}` 占位符锚定。
- `gateway/tsconfig.build.json`：将 `@deepseek-ai/cordis` 映射到 `vendor/cordis/lib/types`——生产 `tsc -p tsconfig.build.json` 会整体覆盖父级 `paths`，该 vendored 导入此前只能经本地 `node_modules` 符号链接解析，而 `npm ci` 不会创建该链接；windows-native 车道的 spec 首次通过到构建步骤时才撞上 TS2307。
- `.github/workflows/release-vendor.yml`：`NODE_OPTIONS --max-old-space-size=12288`——被调用的 workflow 不继承调用方的 `env`，而 `pnpm run build:lib:host`（直接 `tsc -b tsconfig.host.json`，不走 `compile-referenced-projects.ts` 的堆参数）在默认约 4 GB 堆上 OOM。
- `scripts/no-unknown-casts.baseline.json`：为 rc.3 吸收的断言集合重新生成清单（指纹是内容哈希，任何被编辑的断言都会被视为新增）。

## 后果

- Linux `python runtime / release-shaped matrix` 车道与 macOS 车道复用同一套期望文件；root 与委托身份尾段经既有 `{{agent-*}}` 归一化按会话文件锚定，因此 fixture 保持平台无关。
- 本地经 `--update-snapshots` 重录仍是可用时的首选；打包 runtime 在 macOS 上无法派生其内嵌 shell，office 场景还需要仅限 Linux 的内嵌 node 布局，因此本次以确定性变换复现生成器自身的 JSON/JSONL 序列化，CI 仍是验证面。

## 备选方案

- 改而吸收上游的 `supersedes` 式引语被否决：fork 横幅是对齐台账中已记录的吸收决定，且该目录之外的每个产品快照都已携带它。
