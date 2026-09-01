# Agent Note: 有选择地整合上游 alpha.2 与 alpha.3

Status: implemented

[English](2026-09-01-selective-upstream-alpha2-alpha3-sync.md) | 中文

## Problem

上游 `dsh-v0.1.2-alpha.2` 与 `dsh-v0.1.2-alpha.3` 包含产品修复、性能工作、包边界范式调整以及两项破坏性移除。CoHarness 与这些 tag 没有共同 Git ancestor，并且拥有自己的 Gateway 授权、ApiProxy 传输、Session 持久化、UI façade 和移动端呈现。按文件合并要么会丢失这些本地约定，要么会复制本项目没有所有者的上游 API。

## Decision

本 fork 记录两个 tag，并在对应能力的所有者处移植行为，而不合并历史。完整对比与状态矩阵位于 [`UPGRADE-PLAN-dsh-v0.1.2-alpha.2-alpha.3.md`](../../../../UPGRADE-PLAN-dsh-v0.1.2-alpha.2-alpha.3.md)，机器可读的来源与决策清单位于 [`UPGRADE-MANIFEST-dsh-v0.1.2-alpha.2-alpha.3.json`](../../../../UPGRADE-MANIFEST-dsh-v0.1.2-alpha.2-alpha.3.json)。

已随代码采用的上游行为如下：

- 连接 generation 通过既有 `connected/reconnecting` 本地状态提供恢复提示和立即重试；WebSocket downlink 在终止前容忍两次漏掉的 heartbeat 以及一个事件循环 turn。没有复制上游依赖浏览器 `online/offline` 事件的暂停钩子，因为 CoHarness 的 Connection 直接拥有两个 logical stream，并以 transport generation 结果作为网络权威。
- vendored Loader 按内部 v1/v2 API 的方法存在性识别 Node resolver。原子文件替换会重试临时性的 Windows rename 干扰，JSONL Session 探测只在 Windows 执行父路径 stat。
- Schedule 提供带 header 的 Session projection 和 opt-in 的只读浏览器目录。投影 cell 处理 seed 边界、detached append 和 raw-view identity 去重；创建检查点会捕获 seed 派生的值。
- Agent-preset 组装可以被插件清单读取，而不会激活未挂载的 preset。live 行携带求值后的 Fiber 状态，未解析的 `!!js` 行保持 `conditional`，内置展示文本本地化，设置清单区分 preset 与 global 作用域。
- 既有 `ui-conversation` façade 提供全会话轮次导航、未加载标记加载、固定 pitch 滚动、视口门控的 `CodeBlock`/`ReadBlock` 高亮、增量流式行组，以及高亮斜杠命令的 Tab 补全。stale pending refinement 尚未收敛时，Enter 与 Tab 都会消费按键而不选择旧候选，也不会落入提交。Queue 行会从文本预览中省略图片标记，经会话授权的 conversation 图片缓存加载持久化缩略图，并在 Host 的 `rpcId` 到达前保留本地 queued 回显。
- Agent loop 会在消息被认领或丢弃前记录唤醒消息身份；因此在正常轮次收尾微任务中到达的 follow-up 或 steer 会重新拉起新的 driver，而取消、pre-step 拒绝和 driver 失败仍会让保留的 inbox 工作停放。
- `read_image` 从字节识别无扩展名的 PNG/JPEG/GIF/WebP 附件，同时由 AttachmentStore 继续负责完整解码和部署限制。持续子代理后续消息在进入 inbox 前接收 upload-shaped 图片，并检查子模型已解析的图片 modality；能力查询之后再次检查 disposal，避免正在关闭的 live child 接收请求。
- Web Search 失败保留生效 endpoint 和可操作的设置位置。内置权限标签使用当前 locale，部署自定义标签保持原文。

有意保留的 CoHarness 决策如下：

- Gateway 的 `TypertGatewayError`/业务 RPC 错误分类、项目 ACL、principal、credential 和 participant 规则仍是权威。不上游的 domain-prefixed `RemoteError` 或完整 `remote.*` controller 闭包替换它们。
- `packages/host/apiproxy`、`packages/client/connection` 和 `packages/client/runtime` 仍是生产传输与 history-wire 的所有者。上游 focused `ui-chat`、`session-turn-outline` 和共享 utility 包在已有行为处用本地等价实现承载。
- Session SQLite 持久化、schema/迁移/导出路径、`SESSION_FORMAT_VERSION = 0` 与 `SessionEvent.ignorable` 继续可用。alpha.3 的 SQLite 移除不应用于依赖该后端的现有用户和数据。
- CoHarness DSH 发布族针对 `dsh-v0.1.2-alpha.3` 代码基线使用唯一发行版本 `0.1.2-alpha.3.coharness.1`，并将其统一写入 workspace 根、可发布的 `packages/*/*` 与 `apps/cli`、`apps/web`，以及私有 experimental 包。发布 tag 为 `dsh-v0.1.2-alpha.3.coharness.1`。`apps/android-shell` 仍保留独立的私有应用版本 `0.1.0`；vendored 与 native 发布族继续使用各自版本线。模型治理插件的 peer pin 已跟随 `0.1.2-alpha.3.coharness.1`。该版本表示同步后的 CoHarness 代码基线，不承诺与上游发行版二进制兼容。

每个采用的 model-visible 或持久行为都具备来源事件、projection 或 wire 字段以及聚焦测试。可选的 Schedule UI 在默认 Web bundle 中仍禁用，只由 `examples/web-schedule` 显式启用。

## Release comparison

alpha.2 tag 使用 `git diff --no-renames --shortstat` 统计为 1609 个文件（新增 `28539` 行、删除 `14727` 行），alpha.3 tag 为 1043 个文件（新增 `11337` 行、删除 `11350` 行）。release 正文列出 alpha.2 的 16 项和 alpha.3 的 9 项；对比还覆盖了改变 projection 语义、依赖所有权、队列复杂度、图片准入和测试基础设施的非正文提交。

详细矩阵把每一项 release 条目标为 `implemented`、`adapted`、`baseline-equivalent` 或 `intentionally not adopted`，并列出本地源码和测试所有者。矩阵特别区分 alpha.3 轮次 rail 与 CoHarness 原有 history index，也区分基线已经具备的图片回显和本轮新增的持续子代理图片准入路径。

Goal projection、`@` 目录下钻、工具体延迟格式化和 inbox 线性化的聚焦运行时决策记录在[选择性运行时适配笔记](2026-09-01-alpha23-selective-runtime-adaptation.zh.md)中；本笔记继续作为发布范围的来源矩阵与版本记录。

## Verification

受影响包的 TypeScript program、聚焦 Vitest、Cordis 配置/API catalog、client 包声明、runtime closure、optional-import 与 client-domain 检查、Schedule 与 inventory bundle，以及翻译/文档配对检查均针对 source plane 执行。关闭生命周期脚本后，DSH、vendored 和 Landlock tarball 的隔离安装成功，并由纯 Node 的 `dsh --version` 入口报告 `0.1.2-alpha.3.coharness.1`。Python 发布转换器会将仓库版本映射为公开的 PEP 440 wheel 版本 `0.1.2a3.post1`；其 13 个版本测试和 SDK wheel 构建均通过。macOS 正常生命周期路径仍未验证，因为本环境的 `koffi` 没有可用预构建二进制，且主机没有 CMake。根目录升级记录保存了精确命令和本地结果。Windows 原生 Loader/PTY 行为、真实 DeepSeek API、组装浏览器 snapshot 和生产 Gateway 时序仍是外部证据，不能从 macOS 测试推断。

## Alternatives considered

**复用上游的精确 npm 版本。** 拒绝，因为 248 个 DSH 包名／版本对中有 225 个已经在公共 registry 中存在，其 metadata 指向上游仓库，tarball integrity 也与本地不同。npm 将已发布的包名／版本对视为不可变，因此该精确版本无法承载 CoHarness 内容。

**将 CoHarness 后缀放进 PEP 440 local version。** 对公开 Python wheel 拒绝，因为公共索引不接受 local version 标识符。仓库版本保留 `0.1.2-alpha.3.coharness.1`，Python wheel 使用公开的 post-release 写法 `0.1.2a3.post1`。

**合并或 cherry-pick 上游 tag。** 拒绝，因为两边没有共同 ancestor，且相同路径代表不同所有者。文本冲突解决无法同时保留 Gateway 授权、history-wire 字段和本地 UI 组合。

**复制全部上游包，再晚些时候重命名本地界面。** 拒绝，因为 focused 包拆分和 `remote.*` 闭包会在 CoHarness 尚无兼容消费者时改变公开依赖与错误边界。本地等价实现提供行为而不创建第二套无主传输。

**执行 alpha.3 的 SQLite 移除。** 拒绝，因为 fork 仍服务现有 SQLite Session 文件，迁移/导出行为属于部署业务路径。移除提供方会造成数据和可用性回归，而不是清理。

**在本地错误分类旁再暴露上游 `RemoteError`。** 拒绝，因为同一个 Gateway endpoint 出现两套异常词汇会迫使客户端按来源而不是负责的故障分类分支。既有 typed Gateway error 和 RPC envelope 已经保留本地授权与诊断约定。

**默认开启全部新 UI 和 Schedule row。** 拒绝，因为 Schedule 会引入工具、定时器和 projection 状态，而 fork 的默认组合刻意不提供提醒能力。overlay 让功能保持显式且可回退。

## Consequences

该 fork 跟随上游面向用户的修复和低风险运行时加固，同时保持自己的持久数据、授权和传输约定稳定。后续上游 tag 可以对照一份机器可读矩阵和一份决策记录审查，而不依赖 release 文案或不安全的 merge。代价是需要维护语义差异：上游包名、Remote 错误码、SQLite 可用性和部分 focused component API 与 CoHarness 不具有二进制兼容性，采用行为在进入生产发行前仍需外部平台 lane 验证。
