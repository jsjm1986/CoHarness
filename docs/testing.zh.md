# 测试策略

[English](testing.md) | 中文

命令位于根目录 [AGENTS.md](../AGENTS.md)，链接的 Agent Note 记录设计理由。

## 层级

- **Gateway 插件**（`pnpm run test:plugins`）：插件测试套件为 runtime CI 必需检查；插件变更触发 Gateway 集成检查（[详情](../.agents/notes/implemented/testing/2026-09-17-required-gateway-plugin-tests.zh.md)）。

- **单元测试**（`pnpm run test`）：vitest 运行包和示例的 `tests/**` 测试与 `scripts/**/*.spec.ts`；测试文件与其所覆盖的代码放在一起。每个注册表都有一个 HMR（热模块替换）安全测试（对向该注册表贡献内容的 fiber 执行 dispose（资源释放），并断言清理完成）。优先覆盖边界情况、错误路径、事件顺序、竞态，以及针对约定回归的永久测试（见 `packages/core/agent-loop/tests/contract-regressions.spec.ts`）。
- **覆盖率门禁**（`pnpm run test:coverage`）：门禁级运行，对 `packages/*/*/src` 按文件 100% 覆盖。未覆盖的行往往是门禁标记出的死代码（应删除），而非需要补写的测试。行覆盖率是必要条件，但永远不是充分条件：行被执行过不证明功能按交付预期工作。全量、分片与增量运行共用[同一测量策略](../scripts/coverage-policy.ts)。`packages/shell/pwsh-local/src` 需要真实的 `pwsh`：无 `pwsh` 的主机上执行器套件自动跳过，策略记录该依赖宿主环境的排除项；CI 自带 pwsh 并按完整标准执行门禁。
- **真实 API e2e**（`pnpm run test:e2e`）：带密钥测试调用真实提供方 API，包括 DeepSeek 以及各提供方特有的冒烟测试；这些测试各自由自己的密钥控制（`EXA_API_KEY`、`PERPLEXITY_API_KEY` 等），缺少密钥时套件自动跳过，使 keyless CI 保持绿色（[真实 API e2e Agent Note](../.agents/notes/implemented/testing/2026-06-19-real-api-e2e-ci.zh.md)）。
- **快照**（`pnpm run test:snapshot`）：无密钥预期输出覆盖传输约定与呈现；持久化日志固定组装后的后端行为。ACP 启动自动化服务器示例、回放录制会话，并对归一化 JSON-RPC 与重新持久化的日志执行 diff（[ACP 快照 Agent Note](../.agents/notes/implemented/testing/2026-06-19-acp-snapshot-tests.zh.md)）；headless 场景通过未导出的 JSONL 测试 driver 启动各自显式的示例组装，`apps/cli` 负责产品 CLI（命令行界面）`dsh --profile headless` 的验收。transcript（文本记录）变化时使用 `test:snapshot:record`，回放输入仍有效时使用 `test:snapshot:refresh`；请审查每一处 JSONL 与预期差异。一个 ACP 场景（`text-turn`）固定完整的系统提示词与工具 schema 内容；其他 fixture（测试前置数据）将其 token 化，因此修改只会扰动一行（[pinned-header Agent Note](../.agents/notes/archived/testing/2026-07-06-pin-request-header-content-in-one-scenario.md)）。
- **Web 浏览器快照**（`pnpm run test:web`；始终存在的 `web verification` PR 检查）：Chromium 将回放后的浏览器输出与 `apps/web/tests/snapshots/` 比较。CI 强制只读的 `DSH_SNAPSHOT=replay`，record/refresh 留在本地，每处 golden diff 都须评审（[web e2e 车道](../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.zh.md)、[CI 门禁决策](../.agents/notes/implemented/testing/2026-07-30-web-browser-snapshot-ci-gate.zh.md)、[分层验证决策](../.agents/notes/implemented/testing/2026-09-11-web-verification-tiering.zh.md)）。`scripts/ci-pr-scope.ts` 依据 `scripts/web-test-policy.json` 为每个 PR 选择 `skip`/`scoped`/`focused`/`full` 层级；无法分类的路径与未映射的浏览器渲染包回退到 `full`。`test:web` 会[先构建](../.agents/notes/implemented/bug-fix/2026-07-28-themed-scrollbars-and-reserved-gutter.zh.md)以交付插件 CSS。

签入仓库的会话格式 JSONL 使用规范打包行布局；无密钥快照门禁通过 `session` header 发现每一份此类 fixture，[临时迁移器](../scripts/migrate-packed-session-fixtures.ts)改写旧版布局。

## spec 如何执行

分叉（fork）worker 并发运行 spec 文件，覆盖率门禁拆分为并发分区，自托管运行器共享一台主机与一个卷。被隔离的只有进程：端口、可预测路径、外部命名空间与被继承的子进程都不在隔离范围内。每个获取的资源都必须经清理释放；一个只有单独运行才能通过的 spec 是缺陷，而非不稳定的运行器。[dsh-ci-test-reliability](../.agents/skills/dsh-ci-test-reliability/SKILL.md) 负责分配、恢复、同步、超时预算、平台与清理规则；其[故障诊断工作流](../.agents/skills/dsh-ci-test-reliability/references/ci-flake-diagnosis.md)用于对概率性失败进行分类。

## 带密钥策略：推理（inference）在这里很便宜

手动运行 [DeepSeek 工作流](../.github/workflows/e2e.yml)需要 GitHub Actions Secret `DEEPSEEK_API_KEY_EXTERNAL`。自动运行还要求 `DSH_REAL_API_E2E_ENABLED=true`；手动验证不会启用自动定时运行。

我们是 DeepSeek，不要吝惜真实 API 测试。无密钥测试只能证明底层通路；只有带密钥运行才能证明 agent（智能体）能对接真实模型正常工作。覆盖文件写入提示词、包含多个轮次的对话、工具使用和流中取消。价值最高的是**冒烟测试**：启动真实示例、发送一条提示词，并检查外部世界；它们能捕获「单元测试全绿、产品却坏了」这一类 mock 无法发现的问题（[事故复盘 0001](postmortem/0001-acp-default-export-drops-inject.zh.md)）。自动跳过让无密钥 CI 和无密钥贡献者不受阻塞；它不是成本信号。每个示例都提供无密钥和带密钥冒烟测试（[examples/AGENTS.md](../examples/AGENTS.md)）。

## 优先使用真实实现而非 mock

只 mock 开销高或不确定的边界（LLM（大语言模型）适配器、网络、时钟）；下游一切保持真实。手写替身只能证明桥接层在搬运字节，不能证明交付的工具行为符合断言。桥接工具调用测试将脚本化 mock 模型与真实工具和执行器配合使用：`makeBridgeHarness({ withBash: true })` 接入 `dsh-bash-local` 与 `dsh-tool-bash`，然后运行 `echo`。

恢复测试按步骤区分分片前与分片后的失败，并证明失败分片不会派生出消息或工具副作用。覆盖耗尽、取消、策略组合、持久化、状态、协议计数、传输空闲超时，以及交付的 Loader 组合。

## 验证外部世界，而非自我报告

e2e 断言应重新运行命令或从外部重新读取文件；对 agent 自身输出做关键词探测会让作弊的 agent 通过。断言未修改的文件逐字节一致。e2e 测试自行管理资源：在测试中创建 harness，在 `afterEach` 中 dispose（即使失败或超时也要释放）；共享 fixture 放在普通的 `tests/harness.ts` 中，绝不放在另一个 `*.e2e.ts` 中（导入 spec 会重新注册其 `describe`）。

## 测试真实入口路径

- 产品可见的插件必须有一个非单元的真实组合测试。手动构建的 `ctx.plugin(...)` 套件不够：通过 Loader 和 app/process 启动仅用于测试的 `cordis.yml`，只 mock 外部服务或非确定性输入，断言模型可见的请求/日志、持久状态或用户可见输出。不要把 opt-in 选项混入交付默认值。
- 一个守卫只有在回归真的能让它失败时才有效。对于没有 `inject` 的插件（bundle/组合插件），Loader 冒烟测试在默认导出替换必需的具名导出时仍然绿着——需要添加显式的 `expect('default' in mod).toBe(false)` 加 `unwrapExports` 往返断言，并先证明回归变红再回退。
- 「真实入口路径」指已发布的产物：包的 `bin` 所运行的是构建后的 `lib/bin.js`，并由普通 `node` 执行，从而暴露 tsx 会掩盖的失败（结算竞态、模块解析、被吞掉的加载失败）。同样的规则适用于非 index 运行时入口（worker-thread 的同级文件 `lib/worker.cjs`），也适用于多个 bundle 共享的单例模块（`packages/sdk/server/tests/built-scope-carrier.e2e.ts`）。保持构建产物冒烟测试绿色（`packages/examples/*/tests/built-bin.e2e.ts`、`packages/ptc-runtime/ptc-runtime-node/tests/built-lib.e2e.ts`），并断言真正缺失的配置以非零状态退出。

## 测试解析：仅限源码

- 每个 vitest 配置都将 vite-tsconfig-paths 指向 `tsconfig.base.json`；工作区包的裸导入解析到 `src`（[布局](development.zh.md#typescript-project-layout)），绝不会经由包的 `exports` 解析到构建后的 `lib/`，陈旧产物会加载第二份模块单例。构建产物只在显式指定时使用：以 `lib` 模式运行的子进程，以及下文的构建产物冒烟测试。

## 测试子进程启动模式

- CI 与已有构建产物的测试通道通过共享双模式启动器，从构建后的 `lib/` 运行每个示例或 Cordis 配置子进程；不要手写 `--import tsx`。
- 跳过 Cordis 的协议与操作系统 fixture 直接通过 Node 运行可擦除 `.ts`，不经过 tsx 或根路径映射。
- 只有测试对象本身是源码路径解析时，才可以选择 `src`；在测试中写明这一约定。

## 何时需要快照测试

每项非平凡的模型可见、协议可见或人类可见变更，都必须在同一 PR 中，通过可运行示例所属的快照套件添加或更新无密钥场景。包测试、e2e 断言、mock 与仅测试组合、PR 理由都不能取代组装后的 transcript；必要时应扩展 harness。ACP 自动化场景使用 `examples/<name>/tests/snapshots/`，即基于 [`dsh-acp-snapshot`](../packages/test-support/acp-snapshot/README.zh.md) 套件工厂的场景表（`examples/acp-agent` 为主套件）；`examples/headless-agent` 拥有内部规范事件 JSONL 快照与回放 fixture。`pwsh-tool-turn` ACP 场景启动真实 `pwsh`，在无 `pwsh` 的主机上跳过。已完成的交互式终端旅程使用 `apps/cli/tests/snapshots/` 下由 JSONL 驱动的场景；瞬态呈现使用包内语义矩阵，输入、Loader 选择或终端清理发生变化时还要添加 PTY 用例。浏览器渲染的 Web GUI 旅程使用上述 Web 应用快照套件。两个 SDK 各自独立地投影 agent loop、会话生命周期与 `SessionEventMap`，因此改动其中任何一项都要同时更新两者：`examples/jsonrpc-agent/tests/snapshots/` 拥有 TypeScript 客户端；`scripts/snapshots/python-sdk-single-exe/` 拥有 Python 客户端，且只有必需的 `python-runtime` CI 作业会运行它。新的能力 seam、生命周期变体或 transcript 呈现接口在计划阶段就要列出每个覆盖层级，并在实现前验证 harness 能够表达它们。

## 验证范围与证据

[诚实性检查](../scripts/verify-test-honesty.ts)要求覆盖率 ignore 和无条件跳过提供理由。CI 拒绝陈旧 lint 抑制，本地 `--fix` 保留诊断警告。[消费方关系](../scripts/ci-consumer-relations.json)解释额外的 fork 检查。影子运行执行新旧并集，golden 摘要保留人工审查责任。[发布证据](../scripts/release/README.zh.md)绑定候选、环境和已测试产物。
