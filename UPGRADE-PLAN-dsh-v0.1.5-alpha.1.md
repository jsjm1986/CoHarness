# CoHarness 对齐 DSH v0.1.5-alpha.1：选择性同步计划

- 审查日期：2026-09-09。
- CoHarness 实现基线：`29c6373ddf1d26408e4da5ddd18c1e4ec6cef40f`（分支 `master`（已合并 Workbench 与上一轮验证 PR），保留当前 Workbench、Gateway 和用户未提交 `.cursor/`）。
- 上游目标：[dsh-v0.1.5-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-alpha.1)，提交 `5dda764ed3aa172535a7967b06ff95d9cbfe536a`；上一个对齐基线为 dsh-v0.1.3-alpha.2（`82a5fd61a7cf5c293cec4bdff68f455398d685e9`）。
- 上游发布说明明确包含 Session format V3、显式 Agent API、Inbox 类型化、动态系统提示词、文件资源 Sidebar、子代理运行时升级、空消息拒绝、目标暂停保护和 Node addon system 重构。
- 上游 alpha.2 到 alpha.1.5 的比较不是可直接合并的共同祖先树；本计划以行为、协议、生命周期、权限和构建产物核对，不以包名或提交数量判断等价。
- 目标版本：`0.1.5-alpha.1.coharness.1`。本地实现与生成物已完成；外部平台验收仍按发布门禁执行。

## 处置规则

- `retain`：CoHarness 业务 owner 和安全边界继续作为权威。
- `equivalent`：已有等价行为，只补证据，不复制上游实现。
- `adapt`：采用上游行为，但保留现有 API、存储、Gateway、ACL 或 UI owner。
- `required`：存在协议、持久化、正确性或安全缺口，必须实现。
- `defer`：新增产品能力，需要独立业务决策或外部环境。
- `reject`：会破坏云端多 runtime、权限隔离、数据出域或回滚语义。

## 当前基线核实

| 领域 | 当前 CoHarness | 与 alpha.1 的判断 |
| --- | --- | --- |
| Session 格式 | `SESSION_FORMAT_VERSION = 3`，已有 v0/v1→v2 adjacent migration、v2→v3 system/message stage 和 immutable successor | `adapted`，保留旧 generation 并在 provider 不支持流式时安全 fallback |
| Agent API | `ctx.agent` 已移除；setup 为 `(agentCtx, agent)`，子代理显式传递 `parentAgent` | `adapted`，Gateway/ACP/子代理/Headless 消费方已更新 |
| Inbox | CoHarness `Inbox` 保留兼容构造器；ApiProxy 已有 agent-free cold `inbox` projection，AgentLoop live owner 仍使用现有 O(1) implementation | `equivalent/retain`，不重复搬运上游 class 拆分；后续 major 版本再移除兼容构造器 |
| 系统提示词 | 已有 prefix/suffix、runtime context 和 surface 投影，但当前日志格式仍为 v2 | `adapt`，接入 V3 system/message 和 route capability，不重复建立第二个 prompt owner |
| LLM/prompt cache | 已有 `systemPromptUpdate: in-history` 的部分能力和 request header | `adapt`，验证模型显式 capability、动态更新与 KV cache 语义 |
| Session persistence | JSONL、SQLite、Gateway 都有 migration/generation 机制，但 target V3 payload admission 尚未覆盖 | `required`，先做 format catalog、历史内容审计和 provider 迁移 |
| 子代理 | continuable、parent Activation、冷恢复和 sender attribution 已有 CoHarness 实现 | `equivalent/adapt`，保留现有归属和权限；补上 alpha.1 的显式 Agent API |
| Codex/Claude | Codex `0.153.4`，Claude Agent SDK `0.3.263` / Claude Code `2.1.263` | `adapted`，保留 CoHarness provider、权限、超时和 teardown |
| Web UI | 当前是 Workbench + ui-conversation/ui-sidebar/ui-workspace，非上游右 Sidebar 树 | `retain/defer`，只移植行为修复，不替换组件树 |
| Workspace 文件资源 | 当前远程 Workspace 文件资源链未作为默认能力启用；User Documents 是独立业务 | `defer`，不因 alpha.1 的 Sidebar 能力自动开启数据出域 |
| 本地绝对路径图片 | 云端不能信任或展示服务器绝对路径 | `adapt/reject`，桌面 loopback 可保留，远程 Web 只使用安全的 attachment/document 引用 |
| API 文件响应 | 当前已有 bounded file/provider 路径和 ACL | `equivalent/adapt`，核对上游 `/api/file` 限制，不开放任意绝对路径 |
| 空消息/空队列编辑 | 需要核对每个 Host、SDK、ACP、Gateway 入口是否都拒绝空文本和空白编辑 | `required`，统一 admission helper，保留图片-only/file-only |
| 目标暂停 | CoHarness Goal 已有 activation 和 manual state，需要确认模型驱动 resume 是否受人工暂停保护 | `required`，人工暂停是持久事实，模型不能自动恢复 |
| 项目根目录错误 | agent-instructions 需区分权限/I/O 错误和“没有项目” | `adapt`，错误直达调用方，禁止向父目录错误回退 |
| PTC/code 命名 | CoHarness 已将 PTC/legacy code 作为兼容语义维护 | `adapt`，V2→V3 迁移中重命名历史 source/type，保留 replay 兼容 |
| Typert forwarding | 上游修复了跨包 forwarding visit identity 和显式边优先级 | `adapt`，核对 CoHarness Typert registry/generator，不直接替换生成器 |
| Native | CoHarness 保持独立 `node-addon-landlock-run` 版本线；上游改为 `node-addon-system` 并增加 flock | `retain/adapt`，不在本版本重命名 Landlock 包；评估 flock 对跨进程 Session lock 的增益 |
| fs-ext | 当前依赖图不应引入 `fs-ext` 本地编译负担 | `equivalent`，确认 lockfile 和构建无该依赖，不复制上游 native 包树 |
| Cordis vendor | 当前 vendored Cordis/Loader/Include/HMR 版本和本地生命周期增强独立维护 | `retain`，只在上游 vendor pin 改变时做精确源码审计，禁止整目录覆盖 |
| 发布/构建 | 当前 host/client 编译面、catalog、invariant 和 bundle patch 已建立 | `adapt`，新包、版本、exports、catalog、SDK/ACP 映射必须同步 |

## P0：Session Format V3 和持久化

上游 V3 将系统提示词纳入消息历史，迁移旧 PTC 事件和 `code` preset 引用，并对历史内容载荷做完整 admission。CoHarness 不能把 v2 header 改成 v3 后继续读取旧 body，否则会丢失 surface、system prompt、引用和 inherited cut 语义。

实施：

1. 在现有 `session-format` 后增加 `session-format-v2-to-v3` 和组合 catalog；v0→v1、v1→v2 继续保持相邻边。
2. 目标版本提升到 3；旧 generation 永不覆盖、删除或自动降级。
3. V2→V3 stage 逐条审计所有 message carrier：`user/message`、`assistant/message`、`tool/result`、Inbox inserted、title request、team delivery、compaction、assistant stream 和反馈旁路。
4. 将旧 `request/header.system` 转为带确定性 identity 的 `system/message` surface；在无法证明 chronology 或消息 identity 安全时拒绝迁移并保留原 generation。
5. 将 `tools-code-mode`、旧 `tool/code-dispatch*`、`agentPreset: code` 的历史引用映射到 PTC 语义；不改变 CoHarness 当前工具显示 owner。
6. JSONL、SQLite、Gateway 分别实现 bounded/streaming restore；没有分页能力时使用受控整体 fallback，并记录降级。
7. 在发布前执行备份、复制 dry-run、torn-tail、并发写入、取消、失败回滚、重启恢复和 seeded inherited cut 验收。
8. 更新 TypeScript/Python SDK、ACP、Headless、Web snapshot 和生成 catalog；V3 读取不支持降级回到 v2。

门禁条件：迁移失败时源文件仍可读；目标 generation 的 header、inherited count、surface nodes、message ids 和 PTC references 可重放；旧日志中出现未审计 carrier 时拒绝而不是猜测。

## P0：Agent / Inbox 公共 API 破坏性迁移

上游移除 `ctx.agent`，并将 Inbox 从可构造 class 改为类型接口。CoHarness 的多 runtime、Gateway 和子代理代码必须显式传递 Agent，不能以 Context 属性代理恢复身份。

实施：

- `AgentSetup(agentCtx, agent)`、`CreateAgentOptions.parentAgent`、`ResumeAgentOptions.parentAgent` 统一显式化。
- 删除 `ctx.agent` declaration、accessor 和所有生产消费者；`ctx.agents.currentInitiator()` 只保留给确实需要进程本地 initiator 的可选场景。
- `Agent` 保留 `inbox: Inbox` 类型；将 class 实现移入 agent-loop 的私有模块，Host/API 测试使用生产 loop 或 testkit，不从公共入口构造。
- 保留 CoHarness 的 durable inbox projection、maxMessages/maxBytes、O(1) identity lookup、duplicate identity 校验和 cold queue 规则。
- 所有 function plugin、Service、Remote、SDK、ACP 和 external plugin 更新类型导入与 setup callback。
- 增加旧 API 编译失败、Loader real-composition、HMR reload/dispose 和子代理 parent ownership 测试。

## P1：动态系统提示词和 LLM 路由

采用上游“模型显式声明支持才不破坏 KV Cache”的能力判断，但保留 CoHarness 已有的 prefix/suffix、runtime context、surface projection 和 Gateway model governance。

- `systemPromptUpdate` 只由模型 catalog/adapter capability 提供，不由 UI 或普通设置隐式开启。
- `in-history` 路由将动态系统提示词写入 V3 system surface；不支持的模型使用既有 leading-system 或稳定 fallback。
- 每次动态更新必须有 durable event/replay 证据，不能只修改内存 prompt。
- model governance、BYOK、Gateway route policy 必须仍在请求准入前生效。
- 增加 prompt unchanged、supported route、unsupported route、model switch、resume 和 KV-cache request-header snapshots。

## P1：子代理和第三方运行时

更新：

- `@openai/codex` → `0.153.4`
- `@anthropic-ai/claude-agent-sdk` → `0.3.263`
- `@anthropic-ai/sdk` → 上游使用的 `0.93.0`，需确认 CoHarness 现有 SDK 依赖是否被其他业务锁定后再升级。

保留：

- continuable child 的 parent Activation、sender attribution、冷恢复和 Gateway ACL。
- CoHarness 的 timeout、process-tree cleanup、credential scrubbing、model governance。

验证：

- Codex app-server method/error union、permission ordering、steer/interrupt、native payload。
- Claude Agent SDK session/permission/tool result、取消与 teardown。
- 两个实例环境隔离、显式模型保持不变、未配置模型走 provider default。
- Python/ACP/Headless snapshots 和真实 wrapper smoke。

## P1：输入、Goal 和项目根目录修复

- 所有消息入口统一拒绝空白文本且无附件的消息；图片-only/file-only 保留。
- Queue edit 的 normalize 后为空时拒绝；不会消耗队列预算或产生空 splice。
- Goal manual pause 写入 durable state；模型 round、reconnect、resume 都不能自行恢复，只有用户显式操作可恢复。
- root marker 的权限或 I/O 错误直接返回结构化错误；只有明确的“无 marker”才按无项目处理。
- 上述规则覆盖 Agent、Gateway/API、Web、SDK、ACP、Headless 和 replay，不只修 UI schema。

## P1：Web 与 Workbench 体验适配

保留 CoHarness 多 Session、多 runtime、Workbench pane、Documents、Gateway ACL 和现有 slot façade。

采用行为：

- Send 按 busy setting 与 Enter 保持一致，明确 queue/steer。
- 思考摘要折叠时去除 Markdown 粗体标记，展开内容不变。
- 文件链接和产物行继续使用安全资源引用；远程 Web 不显示服务器绝对路径，也不调用服务器 `openPath`。
- 统计摘要可以采用上游两个 icon pill 的信息组织，但不替换现有 Workbench DOM，需通过现有 slots 适配。
- Slash command 中文描述随 locale 即时更新，同时保留打开菜单和查询内容。
- 长历史、流式 Markdown、窄屏和全屏行为只移植已验证的局部修复。

暂缓：

- `ui-sidebar-right`、`ui-sidebar-files`、`ui-sidebar-textpreview`、`ui-dockkit` 整体入口。
- `ui-chat` 替换 `ui-conversation`。
- `workspace-files` 和 `client/resources` 默认组合。

## P1：API 文件、媒体和安全边界

- 核对上游 bounded `/api/file`、extension allowlist、非 regular file 拒绝、Range 解析和响应大小限制。
- CoHarness 的 Gateway principal、Session ACL、Workspace root 和 Documents transfer broker 继续作为授权 owner。
- 云端响应不得泄露 server absolute path、E2B host path、`FsTargetKey` 或 filesystem probe 错误细节。
- POSIX absolute image path 仅在已验证 local loopback desktop Host 处理；远程 Web 映射到 attachment/document resource，失败显示安全 alt text。
- 不把 User Documents 当成 Workspace 文件；不新增无 ACL 的同源文件 HTTP 服务。

## P1：Typert、Cordis 和构建系统

- 对比上游 Typert forwarding 的 visit identity、explicit edge priority 和 package-local forwarding，保持现有 generated Remote 合并点。
- 维持 Service Definition / Provider / Consumer 三角色，所有新能力走 Cordis `inject/apply/effect/on`，每个 stream/listener/timer 有 disposer。
- 不整包迁移上游 `session-controller`、`client/store` 或 vendor；在现有 owner 内适配。
- 若增加 V3 或模型 capability 包，补齐 `src/types.ts`、host/client tsconfig references、`./invariant`、package exports/files、README、catalog 和 real Loader composition test。
- 现有 vendored Cordis 的本地生命周期 hardening、lazy config、Include/HMR transactional update 和 scoped rescope 必须保留并重新跑 vendor manifest guard。
- native system/flock 作为独立可选能力评估；不改 Landlock 公共包名和独立版本线。

## 本轮已落地的实现证据

- Session V3：`system/message`、v2→v3 immutable migration、surface reference remap、compact assistant stream 和 failed `assistant/attempt` 已进入现有 Session/JSONL/SQLite/Gateway owner。
- Cordis/Typert：`Context.agent` 已删除；Agent setup 与 parent ownership 显式化；Remote decorator 使用版本化 prototype descriptor；Typert generator 已支持 package-local forwarding、显式 Remote stream marker 和真实 CompilerHost resolution。
- 业务安全：Host prompt/queue edit 拒绝空白内容；Goal 人工 pause 会取消非模型发起的运行；root marker 只吞明确缺失，权限/I/O 失败原样返回。
- 第三方运行时：Codex、Claude Agent SDK 和 Claude Code fixture 已更新，协议测试通过；CoHarness Gateway、ACL、Documents、Workbench 和 Open in App 继续作为 owner。
- 生成物：Cordis、persistence、tool catalog 和双语 pairing 已重新生成并校验；`lint:contracts-ready`、Host/Client typecheck 和定向测试通过。

未默认启用 Workspace 远程文件资源、右 Sidebar、完整 `ui-chat`、native system/flock 或任意服务器路径打开；这些仍属于独立产品/平台验收范围。

## 版本、迁移和验收

本地代码实现、类型/构建/定向测试和生成物已收口为 `0.1.5-alpha.1.coharness.1`；Windows、macOS x64、真实 API 和生产回滚仍需在 GitHub/部署环境验收后发布。Android、native 和 tree-external plugins 保留独立版本线；不能只改根包版本而留下 peer/API 不一致。

定向测试：

- Session format、persistence JSONL/SQLite/Gateway、Session query、SDK/ACP replay。
- Agent、AgentLoop、Inbox、Subagent、Goal、LLM adapters、model governance。
- API/remotes、Gateway ACL、file/media bounded responses。
- Workbench、conversation、tool rows、locale、documents、open-in-app。
- Typert generator/loader、Cordis Loader/HMR/Include、external plugins。

构建门禁：

```sh
pnpm run typecheck
pnpm run build
pnpm run lint
pnpm run hygiene
pnpm run doc-sync
pnpm run verify-cordis-config
pnpm run verify-plugin-surfaces
pnpm run verify-package-dependencies
pnpm run verify-package-invariants
pnpm run verify-built-package-invariants
pnpm run verify-client-packages
pnpm run test
pnpm run test:coverage
pnpm run test:snapshot
```

外部验收：

- Gateway PostgreSQL 双用户、ro/rw、撤权、principal expiry 和 runtime generation。
- Windows native/filesystem/process/PowerShell/PTY。
- macOS x64 runtime wheel 和 local loopback Open in App。
- Codex/Claude 新版本真实 wrapper smoke。
- 真实 LLM API、长历史迁移和大文件内存 benchmark。
- 云端确认绝不执行服务器 `openPath`，也不向浏览器返回宿主绝对路径。
